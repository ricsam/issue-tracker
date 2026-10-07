import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, sniffRaster } from "./app";
import { recoverAdmin } from "./recover-admin";
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "issue-server-test-"));
  const app = createApp({ dataDir: dir });
  owned.push({ dir, app });
  return { app, dir };
}
const admin = {
  name: "Admin",
  email: "admin@example.com",
  password: "long-password-123",
};
function request(
  app: ReturnType<typeof createApp>,
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  origin = "http://localhost:3000",
) {
  return app.request(path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function setup(app: ReturnType<typeof createApp>) {
  const response = await request(app, "/api/auth/setup", "POST", admin);
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
test("atomic setup, hashed sessions, CSRF, login/logout and expiry", async () => {
  const { app } = fixture();
  expect(
    (await (await request(app, "/api/auth/status")).json()).setupRequired,
  ).toBe(true);
  expect(
    (
      await request(
        app,
        "/api/auth/setup",
        "POST",
        admin,
        "",
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  const responses = await Promise.all([
    request(app, "/api/auth/setup", "POST", admin),
    request(app, "/api/auth/setup", "POST", admin),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const response = responses.find((r) => r.status === 200)!;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  const session = app.db.query("SELECT hash FROM sessions").get() as {
    hash: string;
  };
  expect(session.hash).not.toBe(cookie.split("=")[1]!);
  const user = app.db.query("SELECT password FROM users").get() as {
    password: string;
  };
  expect(user.password).toStartWith("$argon2id$");
  expect(
    (
      await request(app, "/api/auth/login", "POST", {
        email: admin.email,
        password: "wrong-password-123",
      })
    ).status,
  ).toBe(401);
  expect(
    (await request(app, "/api/auth/logout", "POST", undefined, cookie)).status,
  ).toBe(200);
  expect(
    (await request(app, "/api/users", "GET", undefined, cookie)).status,
  ).toBe(401);
  const login = await request(app, "/api/auth/login", "POST", admin);
  expect(login.status).toBe(200);
  app.db.query("UPDATE sessions SET expires=0").run();
  expect(
    (
      await request(
        app,
        "/api/users",
        "GET",
        undefined,
        login.headers.get("set-cookie")!.split(";")[0]!,
      )
    ).status,
  ).toBe(401);
});
test("every private endpoint rejects anonymous requests", async () => {
  const { app } = fixture();
  for (const [method, path] of [
    ["GET", "/api/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/admin/oidc"],
    ["PUT", "/api/admin/oidc"],
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects/x"],
    ["GET", "/api/projects/x/issues"],
    ["POST", "/api/projects/x/issues"],
    ["GET", "/api/issues/x"],
    ["PATCH", "/api/issues/x"],
    ["POST", "/api/issues/x/comments"],
    ["PATCH", "/api/comments/x"],
    ["DELETE", "/api/comments/x"],
    ["POST", "/api/uploads"],
    ["GET", "/api/uploads/x/x"],
    ["POST", "/api/auth/logout"],
  ])
    expect((await request(app, path!, method!)).status).toBe(401);
});
test("assignment is absent from every issue response and rejects writes without erasing legacy data", async () => {
  const { app } = fixture();
  const cookie = await setup(app);
  const { project } = await (await request(app, "/api/projects", "POST", { name: "No assignees" }, cookie)).json();
  const path = `/api/projects/${project.slug}/issues`;
  const { issue } = await (await request(app, path, "POST", { body: "Keep content" }, cookie)).json();
  expect(issue).not.toHaveProperty("assigneeId");
  // Simulate an existing assigned issue from a previous release, without data loss.
  app.db.query("UPDATE issues SET assigneeId=? WHERE id=?").run(issue.authorId, issue.id);
  const detailPath = `/api/issues/${issue.id}`;
  for (const assigneeId of [null, issue.authorId, crypto.randomUUID()]) {
    expect((await request(app, path, "POST", { body: "Rejected", assigneeId }, cookie)).status).toBe(400);
    expect((await request(app, detailPath, "PATCH", { assigneeId, body: "Rejected", state: "closed" }, cookie)).status).toBe(400);
  }
  const detail = (await (await request(app, detailPath, "GET", undefined, cookie)).json()).issue;
  expect(detail).toMatchObject({ body: "Keep content", state: "open", taggedUserIds: [] });
  expect(detail).not.toHaveProperty("assigneeId");
  const list = (await (await request(app, path, "GET", undefined, cookie)).json()).issues;
  expect(list).toHaveLength(1);
  expect(list[0]).not.toHaveProperty("assigneeId");
  const saved = (await (await request(app, detailPath, "PATCH", { labels: ["kept"] }, cookie)).json()).issue;
  expect(saved).not.toHaveProperty("assigneeId");
  const comment = await (await request(app, `${detailPath}/comments`, "POST", { body: "Discussion" }, cookie)).json();
  expect(comment.issue).not.toHaveProperty("assigneeId");
  expect(app.db.query("SELECT assigneeId FROM issues WHERE id=?").get(issue.id)).toEqual({ assigneeId: issue.authorId });
});

test("projects issues comments collaboration, author/admin permissions and restart persistence", async () => {
  const { app, dir } = fixture();
  const cookie = await setup(app);
  const member = await (
    await request(
      app,
      "/api/admin/users",
      "POST",
      { ...admin, email: "member@example.com", name: "Member" },
      cookie,
    )
  ).json();
  expect(member.user.role).toBe("member");
  const login = await request(app, "/api/auth/login", "POST", {
    email: "member@example.com",
    password: admin.password,
  });
  const mc = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await request(app, "/api/admin/oidc", "GET", undefined, mc)).status,
  ).toBe(403);
  expect(
    (await request(app, "/api/admin/users", "POST", admin, mc)).status,
  ).toBe(403);
  const { project } = await (
    await request(app, "/api/projects", "POST", { name: "Demo" }, cookie)
  ).json();
  expect(project.issueCount).toBe(0);
  const { issue } = await (
    await request(
      app,
      `/api/projects/${project.slug}/issues`,
      "POST",
      { title: "One", body: "**Markdown**" },
      cookie,
    )
  ).json();
  expect(issue.number).toBe(1);
  expect(issue.labels).toEqual([]);
  const updated = await (
    await request(
      app,
      `/api/issues/${issue.id}`,
      "PATCH",
      { labels: ["bug"] },
      mc,
    )
  ).json();
  expect(updated.issue).not.toHaveProperty("status");
  expect(updated.issue.title).toBe("One");
  expect(updated.issue).not.toHaveProperty("assigneeId");
  const titleOnly = await (
    await request(
      app,
      `/api/issues/${issue.id}`,
      "PATCH",
      { title: "Renamed" },
      mc,
    )
  ).json();
  expect(titleOnly.issue).not.toHaveProperty("status");
  expect(titleOnly.issue.labels).toEqual(["bug"]);
  expect(titleOnly.issue).not.toHaveProperty("assigneeId");
  expect(
    (
      await request(
        app,
        `/api/issues/${issue.id}`,
        "PATCH",
        { status: "invalid" },
        mc,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        app,
        `/api/issues/${issue.id}`,
        "PATCH",
        { assigneeId: crypto.randomUUID() },
        mc,
      )
    ).status,
  ).toBe(400);
  const { comment } = await (
    await request(
      app,
      `/api/issues/${issue.id}/comments`,
      "POST",
      { body: "Admin note" },
      cookie,
    )
  ).json();
  expect(
    (
      await request(
        app,
        `/api/comments/${comment.id}`,
        "PATCH",
        { body: "Hijack" },
        mc,
      )
    ).status,
  ).toBe(403);
  expect(
    (await request(app, `/api/comments/${comment.id}`, "DELETE", undefined, mc))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        app,
        `/api/comments/${comment.id}`,
        "PATCH",
        { body: "Updated" },
        cookie,
      )
    ).status,
  ).toBe(200);
  const { comment: memberComment } = await (
    await request(
      app,
      `/api/issues/${issue.id}/comments`,
      "POST",
      { body: "Member note" },
      mc,
    )
  ).json();
  expect(
    (
      await request(
        app,
        `/api/comments/${memberComment.id}`,
        "DELETE",
        undefined,
        cookie,
      )
    ).status,
  ).toBe(200);
  app.close();
  const reopened = createApp({ dataDir: dir });
  owned[owned.length - 1]!.app = reopened;
  const detail = await (
    await request(reopened, `/api/issues/${issue.id}`, "GET", undefined, cookie)
  ).json();
  expect(detail.comments[0].body).toBe("Updated");
  expect(detail.issue.labels).toEqual(["bug"]);
  const p = await (
    await request(
      reopened,
      `/api/projects/${project.slug}`,
      "GET",
      undefined,
      cookie,
    )
  ).json();
  expect(p.project.issueCount).toBe(1);
  expect(p.project.openCount).toBe(0);
});
test("upload protection, sniffing, size limit and disposition", async () => {
  const { app } = fixture();
  const cookie = await setup(app);
  const form = new FormData();
  form.set(
    "file",
    new File(['<svg onload="alert(1)"></svg>'], "evil.svg", {
      type: "image/png",
    }),
  );
  const r = await app.request("/api/uploads", {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Cookie: cookie },
    body: form,
  });
  expect(r.status).toBe(200);
  const { attachment } = await r.json();
  expect(attachment.mime).toBe("application/octet-stream");
  expect((await request(app, attachment.url)).status).toBe(401);
  const download = await request(app, attachment.url, "GET", undefined, cookie);
  expect(download.headers.get("content-disposition")).toStartWith("attachment");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(download.headers.get("content-security-policy")).toContain("sandbox");
  const huge = new FormData();
  huge.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big"));
  expect(
    (
      await app.request("/api/uploads", {
        method: "POST",
        headers: { Origin: "http://localhost:3000", Cookie: cookie },
        body: huge,
      })
    ).status,
  ).toBe(413);
  expect(sniffRaster(Buffer.from("GIF89a0000"))).toBe("image/gif");
});
test("input validation, missing origin, trustworthy rate limiting and health", async () => {
  const { app } = fixture();
  expect((await request(app, "/healthz")).status).toBe(200);
  expect((await request(app, "/readyz")).status).toBe(200);
  expect(
    (
      await request(app, "/api/auth/setup", "POST", {
        ...admin,
        password: "short",
      })
    ).status,
  ).toBe(400);
  const cookie = await setup(app);
  expect(
    (await request(app, "/api/projects", "POST", { name: "" }, cookie)).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/projects", {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(app, "/api/issues/absent", "GET", undefined, cookie)).status,
  ).toBe(404);
  for (let i = 0; i < 20; i++)
    await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "X-Forwarded-For": `192.0.2.${i}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  expect((await request(app, "/api/auth/login", "POST", {})).status).toBe(429);
});
test("offline admin recovery preserves identities and revokes sessions", async () => {
  const { app, dir } = fixture();
  const cookie = await setup(app);
  const user = app.db.query("SELECT id FROM users").get() as { id: string };
  app.db
    .query("INSERT INTO identities VALUES (?,?,?)")
    .run("https://issuer.example", "subject", user.id);
  await recoverAdmin(
    join(dir, "app.sqlite"),
    admin.email,
    "replacement-password-123",
  );
  expect(
    (await request(app, "/api/users", "GET", undefined, cookie)).status,
  ).toBe(401);
  expect(app.db.query("SELECT userId FROM identities").get()).toEqual({
    userId: user.id,
  });
  expect(
    (
      await request(app, "/api/auth/login", "POST", {
        email: admin.email,
        password: "replacement-password-123",
      })
    ).status,
  ).toBe(200);
});
test("production requires key and HTTPS and emits Secure cookie", async () => {
  const { dir } = fixture();
  expect(() =>
    createApp({
      dataDir: dir,
      production: true,
      baseUrl: "https://app.example",
    }),
  ).toThrow("SETTINGS_ENCRYPTION_KEY");
  const app = createApp({
    dataDir: dir,
    production: true,
    baseUrl: "https://app.example",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
  });
  try {
    const r = await request(
      app,
      "/api/auth/setup",
      "POST",
      admin,
      "",
      "https://app.example",
    );
    expect(r.headers.get("set-cookie")).toContain("Secure");
  } finally {
    app.close();
  }
});
