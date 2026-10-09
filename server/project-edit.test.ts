import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";

const run = crypto.randomUUID();
const manifest = join(tmpdir(), `project-edit-${run}.json`);
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true }); rmSync(manifest, { force: true }); });

test("project metadata edits validate atomically, preserve links and children, respect archive/auth, and persist", async () => {
  const dir = mkdtempSync(join(tmpdir(), `project-edit-${run}-`));
  dirs.push(dir); writeFileSync(manifest, JSON.stringify({ run, dirs }));
  let app = createApp({ dataDir: dir });
  let cookie = "";
  const req = (path: string, method = "GET", data?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
  });
  try {
    const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.test", password: "long-test-password" });
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    await req("/api/admin/users", "POST", { name: "Member", email: "member@example.test", password: "long-test-password" });
    const login = await req("/api/auth/login", "POST", { email: "member@example.test", password: "long-test-password" }, "");
    const member = login.headers.get("set-cookie")!.split(";")[0];
    const created = await req("/api/projects", "POST", { name: "Original", description: "Original description" });
    expect(created.status).toBe(200);
    const { project } = await created.json();
    const path = `/api/projects/${project.slug}`;
    const { issue } = await (await req(`${path}/issues`, "POST", { body: "Keep this issue #tag" })).json();
    await req(`/api/issues/${issue.id}/comments`, "POST", { body: "Keep this comment" });
    await req(`${path}/board/issues`, "POST", { issueIds: [issue.id], lane: "todo" });
    const children = () => ["issues", "comments", "board_issues", "project_boards"].map((table) => app.db.query(`SELECT * FROM ${table}`).all());
    const before = children();
    const patch = (data: unknown, auth = member) => req(path, "PATCH", data, auth);
    expect((await patch({ name: "  Renamed  ", description: "Updated\nDescription" })).status).toBe(200);
    let saved = (await (await req(path)).json()).project;
    expect(saved).toMatchObject({ ...project, name: "Renamed", description: "Updated\nDescription", issueCount: 1, openCount: 1 });
    expect(children()).toEqual(before);
    expect((await patch({ description: "" })).status).toBe(200);
    expect((await (await req(path)).json()).project).toMatchObject({ name: "Renamed", description: "" });
    expect((await patch({ name: "Only name" })).status).toBe(200);
    saved = (await (await req(path)).json()).project;
    for (const invalid of [{}, { name: " " }, { name: "x".repeat(101) }, { name: "Valid", description: "x".repeat(10001) }, { description: null }, { slug: "new" }, { name: "New", archived: false }, { name: 123 }]) {
      expect((await patch(invalid)).status).toBe(400);
      expect((await (await req(path)).json()).project).toEqual(saved);
    }
    expect((await patch({ name: "Anonymous" }, "")).status).toBe(401);
    expect((await req(path, "PATCH", { name: "Forged" }, member, "https://evil.example")).status).toBe(403);
    expect((await req("/api/projects/missing", "PATCH", { name: "Unknown" })).status).toBe(404);
    // A storage failure on the second field rolls back the first field too.
    app.db.exec("CREATE TRIGGER fail_project_description BEFORE UPDATE OF description ON projects BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    expect((await patch({ name: "Must roll back", description: "Rejected" })).status).toBe(409);
    expect((await (await req(path)).json()).project).toEqual(saved);
    app.db.exec("DROP TRIGGER fail_project_description");
    expect((await patch({ archived: true })).status).toBe(200);
    expect((await patch({ name: "Archived edit" })).status).toBe(409);
    expect((await patch({ description: "Archived edit" })).status).toBe(409);
    expect((await (await req(path)).json()).project.name).toBe("Only name");
    expect((await patch({ archived: false })).status).toBe(200);
    expect((await patch({ description: "After restore" })).status).toBe(200);
    expect(children()).toEqual(before);
    app.close(); app = createApp({ dataDir: dir });
    expect((await (await req(path)).json()).project).toMatchObject({ id: project.id, slug: project.slug, name: "Only name", description: "After restore", createdAt: project.createdAt, archivedAt: null });
    expect((await (await req("/api/projects")).json()).projects[0].name).toBe("Only name");
  } finally { app.close(); }
});
