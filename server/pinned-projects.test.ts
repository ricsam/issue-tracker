import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const { dir, app } of owned.splice(0)) { app?.close(); rmSync(dir, { recursive: true, force: true }); } });
function directory() {
  const resource: (typeof owned)[number] = { dir: mkdtempSync(join(tmpdir(), "pinned-projects-")) };
  owned.push(resource); return resource;
}
async function fixture() {
  const resource = directory();
  const app = resource.app = createApp({ dataDir: resource.dir });
  let cookie = "";
  const request = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Origin: origin, Cookie: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await request("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body); expect(response.status).toBe(200); return response.json();
  };
  const projects = [];
  for (const name of ["A", "B", "C"]) projects.push((await call("/api/projects", "POST", { name })).project);
  return { app, dir: resource.dir, request, call, projects, cookie };
}
const pins = "/api/me/pinned-projects";

test("migration retains all favorites in legacy order per user and persisted reorders survive reopen", async () => {
  const { dir } = directory(); const path = join(dir, "app.sqlite");
  const old = openDatabase(path, 14);
  old.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES ('u','U','u@example.com','admin','old'),('v','V','v@example.com','member','old');
    INSERT INTO projects (id,slug,name,description,createdAt,archivedAt) VALUES ('c','c','C','','old','old'),('a','a','A','','old',NULL),('b','b','B','','old',NULL);
    INSERT INTO favorite_projects VALUES ('u','c'),('u','a'),('u','b'),('v','b'),('v','a');`);
  old.close();
  let db = openDatabase(path);
  expect(db.query("SELECT userId,projectId,position FROM favorite_projects ORDER BY userId,position").all()).toEqual([
    { userId: "u", projectId: "a", position: 0 }, { userId: "u", projectId: "b", position: 1 }, { userId: "u", projectId: "c", position: 2 },
    { userId: "v", projectId: "a", position: 0 }, { userId: "v", projectId: "b", position: 1 },
  ]);
  db.exec("UPDATE favorite_projects SET position=CASE projectId WHEN 'c' THEN 0 WHEN 'a' THEN 1 ELSE 2 END WHERE userId='u'");
  const saved = db.query("SELECT * FROM favorite_projects ORDER BY userId,position").all();
  db.close(); db = openDatabase(path);
  expect(db.query("SELECT * FROM favorite_projects ORDER BY userId,position").all()).toEqual(saved);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("pins append, move before/end atomically, validate targets, retain archives and support legacy clients", async () => {
  const { app, dir, request, call, projects: [a, b, c], cookie } = await fixture();
  expect(await call(pins)).toEqual({ projectIds: [] });
  await call(`${pins}/${b.id}`, "PUT");
  await call(`${pins}/${a.id}`, "PUT");
  expect(await call(`${pins}/${b.id}`, "PUT")).toEqual({ projectIds: [b.id, a.id] });
  expect(await call(`${pins}/${c.id}`, "PUT", { beforeProjectId: a.id })).toEqual({ projectIds: [b.id, c.id, a.id] });
  expect(await call(`${pins}/${a.id}`, "PUT", { beforeProjectId: b.id })).toEqual({ projectIds: [a.id, b.id, c.id] });
  expect(await call(`${pins}/${a.id}`, "PUT", { beforeProjectId: null })).toEqual({ projectIds: [b.id, c.id, a.id] });
  for (const body of [null, [], { beforeProjectId: 2 }, { beforeProjectId: "" }, { unknown: true }, { beforeProjectId: a.id }])
    expect((await request(`${pins}/${a.id}`, "PUT", body)).status).toBe(400);
  expect((await app.request(`${pins}/${a.id}`, { method: "PUT", headers: { Cookie: cookie, Origin: "http://localhost:3000" }, body: "{" })).status).toBe(400);
  expect((await request(`${pins}/${a.id}`, "PUT", { beforeProjectId: "missing" })).status).toBe(404);
  expect((await request(`${pins}/missing`, "PUT")).status).toBe(404);
  expect((await request(pins, "GET", undefined, "")).status).toBe(401);
  expect((await request(`${pins}/${a.id}`, "PUT", undefined, "")).status).toBe(401);
  expect((await request(`${pins}/${a.id}`, "DELETE", undefined, cookie, "https://evil.example")).status).toBe(403);
  expect(await call(pins)).toEqual({ projectIds: [b.id, c.id, a.id] });
  const savedRows = app.db.query("SELECT * FROM favorite_projects ORDER BY position").all();
  app.db.exec(`CREATE TRIGGER fail_pin BEFORE UPDATE ON favorite_projects WHEN NEW.projectId='${c.id}' BEGIN SELECT RAISE(ABORT,'test failure'); END;`);
  expect((await request(`${pins}/${a.id}`, "PUT", { beforeProjectId: b.id })).status).not.toBe(200);
  expect(app.db.query("SELECT * FROM favorite_projects ORDER BY position").all()).toEqual(savedRows);
  app.db.exec("DROP TRIGGER fail_pin");
  const reopened = openDatabase(join(dir, "app.sqlite"));
  expect(reopened.query("SELECT projectId FROM favorite_projects ORDER BY position").all()).toEqual([b, c, a].map(({ id }) => ({ projectId: id })));
  reopened.close();
  await call(`${pins}/${c.id}`, "DELETE");
  expect((await request(`${pins}/${a.id}`, "PUT", { beforeProjectId: c.id })).status).toBe(400);
  expect(await call(`${pins}/${c.id}`, "DELETE")).toEqual({ projectIds: [b.id, a.id] });
  await call(`/api/projects/${b.slug}`, "PATCH", { archived: true });
  expect(await call(pins)).toEqual({ projectIds: [b.id, a.id] });
  await call(`/api/me/favorite-projects/${c.id}`, "PUT");
  await call(`/api/me/favorite-projects/${b.id}`, "PUT");
  expect(await call(pins)).toEqual({ projectIds: [b.id, a.id, c.id] });
  expect(await call("/api/me/favorite-projects")).toEqual({ projectIds: [a.id, b.id, c.id].sort() });
  await call(`/api/me/favorite-projects/${a.id}`, "DELETE");
  expect(await call(pins)).toEqual({ projectIds: [b.id, c.id] });
});

test("pins are per-user, hide inaccessible projects without deleting preferences, and reject hidden targets", async () => {
  const { app, request, call, projects: [a, b, c] } = await fixture();
  const { user } = await call("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password: "long-password-123" });
  const login = await request("/api/auth/login", "POST", { email: "member@example.com", password: "long-password-123" }, "");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const member = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body, cookie); expect(response.status).toBe(200); return response.json();
  };
  for (const p of [a, b, c]) await member(`${pins}/${p.id}`, "PUT");
  expect(await call(pins)).toEqual({ projectIds: [] });
  await call(`${pins}/${c.id}`, "PUT");
  await call(`/api/projects/${b.slug}/access`, "PATCH", { visibility: "private" });
  expect(await member(pins)).toEqual({ projectIds: [a.id, c.id] });
  expect((await request(`${pins}/${a.id}`, "PUT", { beforeProjectId: b.id }, cookie)).status).toBe(404);
  expect((await request(`${pins}/${b.id}`, "DELETE", undefined, cookie)).status).toBe(404);
  expect(app.db.query("SELECT projectId FROM favorite_projects WHERE userId=? ORDER BY position").all(user.id)).toEqual([a,b,c].map(({ id }) => ({ projectId: id })));
  await call(`/api/projects/${b.slug}/access`, "PATCH", { visibility: "public" });
  expect(await member(pins)).toEqual({ projectIds: [a.id, b.id, c.id] });
  expect(await call(pins)).toEqual({ projectIds: [c.id] });
});

test("all project responses derive latest issue activity from current membership, including edits and moves", async () => {
  const { app, call, projects: [a, b] } = await fixture();
  expect(a.lastIssueUpdatedAt).toBeNull();
  const get = async (p: typeof a) => (await call(`/api/projects/${p.slug}`)).project;
  const { issue: first } = await call("/api/issues", "POST", { projectId: a.id, body: "First" });
  const { issue: second } = await call("/api/issues", "POST", { projectId: a.id, body: "Second" });
  app.db.query("UPDATE issues SET updatedAt=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first.id);
  app.db.query("UPDATE issues SET updatedAt=? WHERE id=?").run("2001-01-01T00:00:00.000Z", second.id);
  expect((await get(a)).lastIssueUpdatedAt).toBe("2001-01-01T00:00:00.000Z");
  const { issue: edited } = await call(`/api/issues/${first.id}`, "PATCH", { body: "Edited" });
  expect((await get(a)).lastIssueUpdatedAt).toBe(edited.updatedAt);
  const { issue: moved } = await call(`/api/issues/${first.id}`, "PATCH", { projectId: b.id });
  expect((await get(b)).lastIssueUpdatedAt).toBe(moved.updatedAt);
  expect((await get(a)).lastIssueUpdatedAt).toBe("2001-01-01T00:00:00.000Z");
  expect((await call(`/api/projects/${a.slug}`, "PATCH", { name: "Renamed" })).project.lastIssueUpdatedAt).toBe("2001-01-01T00:00:00.000Z");
  expect((await call(`/api/projects/${a.slug}/access`, "PATCH", { visibility: "private" })).project.lastIssueUpdatedAt).toBe("2001-01-01T00:00:00.000Z");
  await call(`/api/issues/${second.id}`, "PATCH", { projectId: null });
  expect((await get(a)).lastIssueUpdatedAt).toBeNull();
  const { project: archived } = await call(`/api/projects/${b.slug}`, "PATCH", { archived: true });
  expect(archived.lastIssueUpdatedAt).toBe(moved.updatedAt);
  const { projects } = await call("/api/projects");
  expect(projects.find((p: any) => p.id === b.id).lastIssueUpdatedAt).toBe(moved.updatedAt);
  expect(projects.find((p: any) => p.id === a.id).lastIssueUpdatedAt).toBeNull();
});
