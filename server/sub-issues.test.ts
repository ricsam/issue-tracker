import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const x of owned.splice(0)) { x.app?.close(); rmSync(x.dir, { recursive: true, force: true }); } });
function directory() { const x = { dir: mkdtempSync(join(tmpdir(), "sub-issues-")), app: undefined as ReturnType<typeof createApp> | undefined }; owned.push(x); return x; }
async function fixture() {
  const x = directory(), app = x.app = createApp({ dataDir: x.dir });
  const request = (auth: string, path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Origin: "http://localhost:3000", ...(auth.startsWith("Bearer ") ? { Authorization: auth } : { Cookie: auth }), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (auth: string, path: string, method = "GET", body?: unknown) => { const r = await request(auth, path, method, body); expect(r.status).toBe(200); return r.json(); };
  const password = "long-password-123";
  const setup = await request("", "/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  const { user } = await call(admin, "/api/admin/users", "POST", { name: "Member", email: "member@example.com", password });
  const login = await request("", "/api/auth/login", "POST", { email: user.email, password });
  const member = login.headers.get("set-cookie")!.split(";")[0]!;
  const { project } = await call(admin, "/api/projects", "POST", { name: "Private", visibility: "private", sharedUserIds: [user.id] });
  const create = async (body = "Issue", extra = {}, auth = admin) => (await call(auth, "/api/issues", "POST", { body, ...extra })).issue;
  const rel = (id: string) => `/api/issues/${id}/relationships`;
  const attach = (id: string) => `/api/issues/${id}/sub-issues`;
  return { app, call, request, admin, member, user, project, create, rel, attach };
}

test("nested cross-project closed relationships, cycles, conflicts and idempotent operations", async () => {
  const { app, call, request, admin, project, create, rel, attach } = await fixture();
  const a = await create("A"), b = await create("B", { projectId: project.id }), c = await create("C");
  await call(admin, `/api/issues/${b.id}`, "PATCH", { state: "closed" });
  const linked = await call(admin, attach(a.id), "POST", { issueId: b.id });
  expect(linked).toEqual({ parent: null, subIssues: [{ id: b.id, number: b.number, title: b.title, state: "closed" }] });
  expect(await call(admin, attach(a.id), "POST", { issueId: b.id })).toEqual(linked);
  await call(admin, attach(b.id), "POST", { issueId: c.id });
  for (const [parent, child] of [[c.id, a.id], [a.id, a.id], [c.id, b.id]])
    expect((await request(admin, attach(parent!), "POST", { issueId: child })).status).toBe(409);
  expect((await call(admin, rel(c.id))).parent.id).toBe(b.id);
  expect(app.db.query("SELECT * FROM issue_relationships").all()).toHaveLength(2);
  expect(() => app.db.query("INSERT INTO issue_relationships VALUES (?,?)").run(b.id, c.id)).toThrow();
  expect(app.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  await call(admin, `/api/issues/${a.id}`, "PATCH", { state: "closed" });
  expect((await call(admin, `/api/issues/${c.id}`)).issue.state).toBe("open");
  await call(admin, `/api/issues/${a.id}`, "PATCH", { state: "open" });
  expect((await call(admin, `/api/issues/${b.id}`)).issue.state).toBe("closed");
  expect((await call(admin, rel(a.id))).subIssues).toEqual(linked.subIssues);
  await call(admin, `${attach(c.id)}/${b.id}`, "DELETE"); // Wrong pair never reparents/detaches.
  expect((await call(admin, rel(b.id))).parent.id).toBe(a.id);
  await call(admin, `${attach(a.id)}/${b.id}`, "DELETE");
  await call(admin, `${attach(a.id)}/${b.id}`, "DELETE");
  expect((await call(admin, rel(b.id))).parent).toBeNull();
  expect((await call(admin, rel(b.id))).subIssues).toHaveLength(1);
});

test("permissions are dynamic after revocation, moves and archive; history never copies relationships", async () => {
  const { app, call, request, admin, member, user, project, create, rel, attach } = await fixture();
  const a = await create("Public"), b = await create("Hidden title", { projectId: project.id }), c = await create("Alternative");
  const historyBefore = await call(member, `/api/issues/${a.id}/history`);
  const memberKey = await call(member, "/api/me/api-keys", "POST", { name: "member writer", scopes: ["read", "write"], expiresInDays: 1 });
  const bearer = `Bearer ${memberKey.token}`;
  await call(member, attach(a.id), "POST", { issueId: b.id });
  expect((await call(member, rel(a.id))).subIssues).toHaveLength(1);
  const path = `/api/projects/${project.slug}`;
  await call(admin, `${path}/access`, "PATCH", { sharedUserIds: [] });
  expect(await call(member, rel(a.id))).toEqual({ parent: null, subIssues: [] });
  expect(await call(bearer, rel(a.id))).toEqual({ parent: null, subIssues: [] });
  expect((await request(bearer, attach(a.id), "POST", { issueId: b.id })).status).toBe(404);
  expect((await request(bearer, `${attach(a.id)}/${b.id}`, "DELETE")).status).toBe(404);
  expect((await request(member, rel(b.id))).status).toBe(404);
  const issuesBefore = app.db.query("SELECT * FROM issues").all();
  expect((await request(member, "/api/issues", "POST", { body: "No orphan", parentId: b.id })).status).toBe(404);
  expect(app.db.query("SELECT * FROM issues").all()).toEqual(issuesBefore);
  for (const method of ["POST", "DELETE"]) expect((await request(member, method === "POST" ? attach(a.id) : `${attach(a.id)}/${b.id}`, method, method === "POST" ? { issueId: b.id } : undefined)).status).toBe(404);
  expect(await call(member, `/api/issues/${a.id}/history`)).toEqual(historyBefore);
  await call(admin, `/api/issues/${a.id}`, "PATCH", { projectId: project.id });
  await call(admin, `/api/issues/${b.id}`, "PATCH", { projectId: null });
  expect(await call(member, rel(b.id))).toEqual({ parent: null, subIssues: [] });
  const conflict = await request(member, attach(c.id), "POST", { issueId: b.id });
  expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "Issue relationship conflict" });
  await call(admin, `${path}/access`, "PATCH", { sharedUserIds: [user.id] });
  expect((await call(member, rel(b.id))).parent.id).toBe(a.id);
  await call(admin, path, "PATCH", { archived: true });
  const archivedBefore = app.db.query("SELECT * FROM issues").all();
  expect((await request(member, "/api/issues", "POST", { body: "No orphan", parentId: a.id })).status).toBe(409);
  expect(app.db.query("SELECT * FROM issues").all()).toEqual(archivedBefore);
  for (const [parent, child] of [[a.id, b.id], [c.id, a.id]]) {
    expect((await request(member, attach(parent!), "POST", { issueId: child })).status).toBe(409);
    expect((await request(member, `${attach(parent!)}/${child}`, "DELETE")).status).toBe(409);
  }
  expect((await call(member, rel(a.id))).subIssues[0].id).toBe(b.id);
  await call(admin, path, "PATCH", { archived: false });
  expect(app.db.query("SELECT * FROM issue_relationships").all()).toHaveLength(1);
});

test("atomic parentId creation on both routes, draft privacy, malformed IDs and forced rollback", async () => {
  const { app, call, request, admin, member, project, create, rel, attach } = await fixture();
  const parent = await create("Parent"), draft = await create("Secret draft", { state: "draft" });
  for (const route of ["/api/issues", `/api/projects/${project.slug}/issues`]) {
    const child = (await call(admin, route, "POST", { body: "Child", parentId: parent.id })).issue;
    expect((await call(admin, rel(child.id))).parent.id).toBe(parent.id);
    for (const extra of [{ parentId: "999999" }, { parentId: draft.id }, { parentId: parent.id, state: "draft" }]) {
      const before = app.db.query("SELECT * FROM issues").all(), history = app.db.query("SELECT * FROM issue_history").all();
      expect((await request(admin, route, "POST", { body: "Rejected", ...extra })).status).toBe(extra.parentId === "999999" ? 404 : 409);
      expect(app.db.query("SELECT * FROM issues").all()).toEqual(before);
      expect(app.db.query("SELECT * FROM issue_history").all()).toEqual(history);
    }
  }
  expect((await request(member, rel(draft.id))).status).toBe(404);
  expect((await request(member, attach(parent.id), "POST", { issueId: draft.id })).status).toBe(404);
  expect((await request(admin, attach(draft.id), "POST", { issueId: parent.id })).status).toBe(409);
  for (const issueId of [1, "01", "0", "-1", "1x", null]) expect((await request(admin, attach(parent.id), "POST", { issueId })).status).toBe(400);
  const before = app.db.query("SELECT * FROM issues").all();
  const historyBefore = app.db.query("SELECT * FROM issue_history").all();
  app.db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON issue_relationships BEGIN SELECT RAISE(ABORT,'forced rollback'); END");
  expect((await request(admin, `/api/projects/${project.slug}/issues`, "POST", { body: "Rollback", lane: "todo", parentId: parent.id })).status).toBe(409); // SQLite constraint failures use the API's generic conflict mapping.
  expect(app.db.query("SELECT * FROM issues").all()).toEqual(before);
  expect(app.db.query("SELECT * FROM board_issues").all()).toEqual([]);
  expect(app.db.query("SELECT * FROM issue_history").all()).toEqual(historyBefore);
});

test("bearer scopes, key revocation, anonymous access and CSRF", async () => {
  const { app, call, request, admin, create, rel, attach } = await fixture();
  const a = await create(), b = await create();
  const read = await call(admin, "/api/me/api-keys", "POST", { name: "reader", scopes: ["read"], expiresInDays: 1 });
  const write = await call(admin, "/api/me/api-keys", "POST", { name: "writer", scopes: ["read", "write"], expiresInDays: 1 });
  expect((await request("", rel(a.id))).status).toBe(401);
  expect((await request(`Bearer ${read.token}`, attach(a.id), "POST", { issueId: b.id })).status).toBe(403);
  expect((await request(`Bearer ${read.token}`, `${attach(a.id)}/${b.id}`, "DELETE")).status).toBe(403);
  await call(`Bearer ${write.token}`, attach(a.id), "POST", { issueId: b.id });
  expect((await call(`Bearer ${read.token}`, rel(a.id))).subIssues).toHaveLength(1);
  expect((await app.request(attach(a.id), { method: "POST", headers: { Cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify({ issueId: b.id }) })).status).toBe(403);
  await call(admin, `/api/me/api-keys/${write.key.id}`, "DELETE");
  expect((await request(`Bearer ${write.token}`, rel(a.id))).status).toBe(401);
});

test("migration 20 is additive, idempotent and transactional with database constraints", () => {
  const { dir } = directory(), path = join(dir, "migration.sqlite");
  let db = openDatabase(path, 19);
  db.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES ('owner','Owner','owner@example.com','admin','2026-01-01');
    INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES
    (1,1,NULL,'Original','Original body','backlog','none','[]','owner','2026-01-01','2026-01-01'),
    (2,2,NULL,'Second','Second body','backlog','none','[]','owner','2026-01-01','2026-01-01');`);
  const issues = db.query("SELECT * FROM issues").all(), users = db.query("SELECT * FROM users").all();
  const schema = db.query("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  db.exec("CREATE TABLE issue_relationships (sentinel TEXT)");
  db.close();
  expect(() => openDatabase(path, 20)).toThrow();
  db = openDatabase(path, 19);
  expect(db.query("SELECT 1 FROM migrations WHERE version=20").get()).toBeNull();
  db.exec("DROP TABLE issue_relationships"); db.close();
  // Isolate migration 20: later migrations intentionally change the issues schema.
  db = openDatabase(path, 20);
  expect(db.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name!='issue_relationships' ORDER BY name").all()).toEqual(schema);
  expect(db.query("SELECT * FROM migrations WHERE version=20").all()).toHaveLength(1);
  expect(() => db.query("INSERT INTO issue_relationships VALUES (1,1)").run()).toThrow();
  expect(() => db.query("INSERT INTO issue_relationships VALUES (1,999)").run()).toThrow();
  db.query("INSERT INTO issue_relationships VALUES (2,1)").run();
  db.close(); db = openDatabase(path, 20);
  expect(db.query("SELECT * FROM issue_relationships").all()).toEqual([{ childId: 2, parentId: 1 }]);
  expect(db.query("SELECT * FROM issues").all()).toEqual(issues);
  expect(db.query("SELECT * FROM users").all()).toEqual(users);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
