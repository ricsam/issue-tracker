import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";

// Exact resources owned by this run; never clean by prefix.
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const e of owned.splice(0)) {
    e.app.close();
    rmSync(e.dir, { recursive: true, force: true });
  }
});
const password = "long-password-123";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "issue-lifecycle-test-"));
  const entry = { dir, app: createApp({ dataDir: dir }) };
  owned.push(entry);
  const send = (
    path: string,
    method: string,
    body: unknown,
    cookie: string,
    origin = "http://localhost:3000",
  ) =>
    entry.app.request(path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const setup = await send(
    "/api/auth/setup",
    "POST",
    { name: "Admin", email: "admin@example.com", password },
    "",
  );
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  const adminUser = (await setup.json()).user;
  await send(
    "/api/admin/users",
    "POST",
    { name: "Member", email: "member@example.com", password },
    admin,
  );
  const login = await send(
    "/api/auth/login",
    "POST",
    { email: "member@example.com", password },
    "",
  );
  const member = login.headers.get("set-cookie")!.split(";")[0]!;
  const memberUser = (await login.json()).user;
  const req = (path: string, method = "GET", body?: unknown, cookie = admin) =>
    send(path, method, body, cookie);
  const json = async (path: string) => await (await req(path)).json();
  const project = (await (await req("/api/projects", "POST", { name: "Life" })).json())
    .project;
  const path = `/api/projects/${project.slug}`;
  const create = async (body = "# Issue\n\nDetails") =>
    (await (await req(`${path}/issues`, "POST", { body, labels: ["bug"] })).json())
      .issue;
  return { entry, send, req, json, admin, member, adminUser, memberUser, project, path, create };
}

test("issues close and reopen with attribution, keep content and board placement", async () => {
  const f = await fixture();
  const issue = await f.create();
  expect(issue).toMatchObject({ state: "open", closedAt: null, closedById: null });
  const other = await f.create("Other");
  expect((await f.req(`${f.path}/board/issues`, "POST", { issueIds: [issue.id, other.id], lane: "in_progress" })).status).toBe(200);
  expect((await f.json(f.path)).project.openCount).toBe(2);
  const patch = (body: unknown, cookie = f.admin) =>
    f.req(`/api/issues/${issue.id}`, "PATCH", body, cookie);

  const closedResponse = await patch({ state: "closed" }, f.member);
  expect(closedResponse.status).toBe(200);
  const closed = (await closedResponse.json()).issue;
  expect(closed).toMatchObject({
    state: "closed",
    closedById: f.memberUser.id,
    body: issue.body,
    title: issue.title,
    labels: issue.labels,
    assigneeId: null,
  });
  expect(Date.parse(closed.closedAt)).not.toBeNaN();
  expect(closed.closedAt).toBe(closed.updatedAt);
  // Closing is issue state only: board membership and lane stay explicit.
  expect((await f.json(`${f.path}/board`)).board.cards).toEqual([
    { issueId: issue.id, lane: "in_progress" },
    { issueId: other.id, lane: "in_progress" },
  ]);
  const counts = (await f.json(f.path)).project;
  expect(counts.openCount).toBe(1);
  expect(counts.issueCount).toBe(2);
  expect((await f.json(`${f.path}/issues`)).issues.map((i: any) => i.state)).toEqual(["closed", "open"]);

  // Repeated close and later edits keep the original close attribution.
  const again = (await (await patch({ state: "closed" })).json()).issue;
  expect(again.closedAt).toBe(closed.closedAt);
  expect(again.closedById).toBe(f.memberUser.id);
  const edited = (await (await patch({ labels: ["done"], body: "# Renamed" })).json()).issue;
  expect(edited).toMatchObject({ state: "closed", closedAt: closed.closedAt, title: "Renamed", labels: ["done"] });

  for (const state of ["done", "Closed", null, true, ""])
    expect((await patch({ state })).status).toBe(400);
  expect((await patch({ state: "open", status: "todo" })).status).toBe(400);
  expect((await f.json(`/api/issues/${issue.id}`)).issue).toEqual(edited);
  expect((await f.send(`/api/issues/${issue.id}`, "PATCH", { state: "open" }, "")).status).toBe(401);
  expect((await f.send(`/api/issues/${issue.id}`, "PATCH", { state: "open" }, f.admin, "https://evil.example")).status).toBe(403);

  const reopened = (await (await patch({ state: "open" })).json()).issue;
  expect(reopened).toMatchObject({ state: "open", closedAt: null, closedById: null, title: "Renamed" });
  expect((await f.json(f.path)).project.openCount).toBe(2);
  // Content and state can change together, atomically.
  const both = (await (await patch({ body: "Both", state: "closed" }, f.member)).json()).issue;
  expect(both).toMatchObject({ state: "closed", title: "Both", closedById: f.memberUser.id });
  expect((await patch({ body: "", state: "open" })).status).toBe(400);
  expect((await f.json(`/api/issues/${issue.id}`)).issue).toEqual(both);

  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect((await f.json(`/api/issues/${issue.id}`)).issue).toEqual(both);
});

test("archived projects are listed, readable and read-only until restored", async () => {
  const f = await fixture();
  const issue = await f.create();
  expect((await f.req(`${f.path}/board/issues`, "POST", { issueIds: [issue.id], lane: "todo" })).status).toBe(200);
  const comment = (await (await f.req(`/api/issues/${issue.id}/comments`, "POST", { body: "Keep" }, f.member)).json()).comment;
  expect(f.project).toMatchObject({ archivedAt: null, archivedById: null });
  const archive = (archived: unknown, cookie = f.admin) =>
    f.req(f.path, "PATCH", { archived }, cookie);

  for (const body of [{}, { archived: "yes" }, { archived: null }, { archived: true, name: "x" }])
    expect((await f.req(f.path, "PATCH", body)).status).toBe(400);
  expect((await f.req("/api/projects/missing", "PATCH", { archived: true })).status).toBe(404);
  expect((await f.send(f.path, "PATCH", { archived: true }, "")).status).toBe(401);
  expect((await f.send(f.path, "PATCH", { archived: true }, f.admin, "https://evil.example")).status).toBe(403);
  expect((await f.json(f.path)).project.archivedAt).toBeNull();

  const archivedResponse = await archive(true, f.member);
  expect(archivedResponse.status).toBe(200);
  const archived = (await archivedResponse.json()).project;
  expect(archived).toMatchObject({ archivedById: f.memberUser.id, issueCount: 1, openCount: 1, name: "Life" });
  expect(Date.parse(archived.archivedAt)).not.toBeNaN();
  // Repeating the archive keeps the original attribution.
  expect((await (await archive(true)).json()).project).toEqual(archived);
  expect((await f.json("/api/projects")).projects).toEqual([archived]);

  const before = {
    issues: await f.json(`${f.path}/issues`),
    board: await f.json(`${f.path}/board`),
    detail: await f.json(`/api/issues/${issue.id}`),
  };
  expect(before.detail.comments).toHaveLength(1);
  const blocked: [string, string, unknown, string?][] = [
    [`${f.path}/issues`, "POST", { body: "New" }],
    [`/api/issues/${issue.id}`, "PATCH", { body: "Changed" }],
    [`/api/issues/${issue.id}`, "PATCH", { state: "closed" }],
    [`/api/issues/${issue.id}/comments`, "POST", { body: "New comment" }],
    [`/api/comments/${comment.id}`, "PATCH", { body: "Edited" }, f.member],
    [`/api/comments/${comment.id}`, "DELETE", undefined, f.member],
    [`${f.path}/board`, "PATCH", { lanes: ["todo"] }],
    [`${f.path}/board/lanes/todo`, "PATCH", { index: 2 }],
    [`${f.path}/board/issues`, "POST", { issueIds: [issue.id], lane: "done" }],
    [`${f.path}/board/issues/${issue.id}`, "PATCH", { lane: "done" }],
    [`${f.path}/board/issues/${issue.id}`, "DELETE", undefined],
  ];
  for (const [path, method, body, cookie] of blocked) {
    const response = await f.req(path, method, body, cookie);
    expect([path, method, response.status]).toEqual([path, method, 409]);
    expect((await response.json()).error).toBe("Project is archived");
  }
  expect({
    issues: await f.json(`${f.path}/issues`),
    board: await f.json(`${f.path}/board`),
    detail: await f.json(`/api/issues/${issue.id}`),
  }).toEqual(before);

  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect((await f.json(f.path)).project).toEqual(archived);

  const restored = (await (await archive(false, f.member)).json()).project;
  expect(restored).toMatchObject({ archivedAt: null, archivedById: null, issueCount: 1 });
  expect((await archive(false)).status).toBe(200);
  for (const [path, method, body, cookie] of blocked.slice(0, 5)) {
    const response = await f.req(path, method, body, cookie);
    expect([path, method, response.status]).toEqual([path, method, 200]);
  }
  expect((await f.req(`${f.path}/board/issues/${issue.id}`, "PATCH", { lane: "done" })).status).toBe(200);
  expect((await f.req(`/api/comments/${comment.id}`, "DELETE", undefined, f.member)).status).toBe(200);
});

test("migration v6 adds open/active lifecycle columns once and preserves existing data", async () => {
  const f = await fixture();
  const issue = await f.create();
  await f.req(`/api/issues/${issue.id}/comments`, "POST", { body: "Keep" });
  const db = () => f.entry.app.db;
  const columns = (table: string) =>
    (db().query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  expect(columns("issues")).toEqual(expect.arrayContaining(["closedAt", "closedById"]));
  expect(columns("projects")).toEqual(expect.arrayContaining(["archivedAt", "archivedById"]));
  const snapshot = () =>
    ["users", "projects", "issues", "comments", "board_issues", "project_boards"].map((t) =>
      db().query(`SELECT * FROM ${t} ORDER BY 1`).all(),
    );
  const fresh = snapshot();

  // Reconstruct a v5 database: no lifecycle columns, no v6 marker.
  db().exec(`
    ALTER TABLE issues DROP COLUMN closedAt; ALTER TABLE issues DROP COLUMN closedById;
    ALTER TABLE projects DROP COLUMN archivedAt; ALTER TABLE projects DROP COLUMN archivedById;
    DELETE FROM migrations WHERE version=6;
  `);
  for (let run = 0; run < 2; run++) {
    f.entry.app.close();
    f.entry.app = createApp({ dataDir: f.entry.dir });
    expect(snapshot()).toEqual(fresh);
    expect(db().query("SELECT COUNT(*) AS n FROM migrations WHERE version=6").get()).toEqual({ n: 1 });
  }
  expect((await f.json(`/api/issues/${issue.id}`)).issue).toMatchObject({ state: "open", closedAt: null });
  expect((await f.json(f.path)).project).toMatchObject({ archivedAt: null, issueCount: 1 });

  // Replaying the version over existing columns never resets lifecycle values.
  await f.req(`/api/issues/${issue.id}`, "PATCH", { state: "closed" });
  await f.req(f.path, "PATCH", { archived: true });
  const lifecycle = snapshot();
  db().exec("DELETE FROM migrations WHERE version=6");
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(snapshot()).toEqual(lifecycle);
  expect((await f.json(`/api/issues/${issue.id}`)).issue.state).toBe("closed");
});
