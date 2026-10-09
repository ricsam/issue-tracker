import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const { dir, app } of owned.splice(0)) { app.close(); rmSync(dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "history-favorites-"));
  const app = createApp({ dataDir: dir });
  owned.push({ dir, app });
  let cookie = "";
  const request = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Origin: origin, Cookie: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await request("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body); expect(response.status).toBe(200); return response.json();
  };
  const { project } = await call("/api/projects", "POST", { name: "Original" });
  const { issue } = await call("/api/issues", "POST", { projectId: project.id, body: "# First", lane: "todo" });
  const history = async (query = "") => call(`/api/issues/${issue.id}/history${query}`);
  return { app, dir, request, call, project, issue, history, cookie };
}

test("history snapshots creation, combined changes, comments, pagination and archive reads", async () => {
  const { app, request, call, project, issue, history } = await fixture();
  const user = app.db.query("SELECT id FROM users").get() as { id: string };
  const created = (await history()).history[0];
  expect(created).toMatchObject({ issueId: issue.id, actorId: user.id, action: "created" });
  expect(created.changes).toEqual([
    { field: "body", before: null, after: "# First" }, { field: "state", before: null, after: "open" },
    { field: "project", before: null, after: "Original" }, { field: "boardLane", before: null, after: "Todo" },
  ]);
  await call(`/api/projects/${project.slug}`, "PATCH", { name: "Renamed" });
  expect((await history()).history[0]).toEqual(created);
  await call(`/api/issues/${issue.id}`, "PATCH", { body: "# Changed\n\n**markdown**", state: "closed", projectId: null });
  expect((await history()).history[0].changes).toEqual([
    { field: "body", before: "# First", after: "# Changed\n\n**markdown**" },
    { field: "state", before: "open", after: "closed" },
    { field: "project", before: "Renamed", after: null }, { field: "boardLane", before: "Todo", after: null },
  ]);
  await call(`/api/issues/${issue.id}`, "PATCH", { state: "closed" });
  expect((await history()).history).toHaveLength(2);
  const { comment } = await call(`/api/issues/${issue.id}/comments`, "POST", { body: "hello **there**" });
  await call(`/api/comments/${comment.id}`, "PATCH", { body: "hello **there**" });
  expect((await history()).history).toHaveLength(3);
  await call(`/api/comments/${comment.id}`, "PATCH", { body: "edited" });
  await call(`/api/comments/${comment.id}`, "DELETE");
  const all = (await history()).history;
  expect(all.slice(0, 3).map((h: any) => h.action)).toEqual(["comment_deleted", "comment_edited", "commented"]);
  expect(all[0].changes).toEqual([{ field: "comment", before: "edited", after: null }]);
  const page = await history("?limit=2"); expect(page.hasMore).toBe(true);
  const next = await history(`?before=${page.history[1].id}&limit=2`);
  expect(next.history).toEqual(all.slice(2, 4));
  expect((await history(`?before=${all.at(-1).id}`))).toEqual({ history: [], hasMore: false });
  for (const query of ["?limit=0", "?limit=101", "?limit=1.5", "?before=-1", "?before=wat"])
    expect((await request(`/api/issues/${issue.id}/history${query}`)).status).toBe(400);
  expect((await request(`/api/issues/${issue.id}/history`, "GET", undefined, "")).status).toBe(401);
  expect((await request("/api/issues/999999/history")).status).toBe(404);
  await call(`/api/issues/${issue.id}`, "PATCH", { projectId: project.id });
  await call(`/api/projects/${project.slug}`, "PATCH", { archived: true });
  expect((await history()).history.length).toBe(6);
  expect((await request(`/api/issues/${issue.id}`, "PATCH", { body: "blocked" })).status).toBe(409);
  expect((await history()).history.length).toBe(6);
});

test("all board routes and bulk bodies log actual changes; failures rollback mutation and events", async () => {
  const { app, request, call, project, issue, history } = await fixture();
  const path = `/api/projects/${project.slug}/board/issues`;
  await call(`${path}/${issue.id}`, "PATCH", { lane: "in_progress" });
  await call(`${path}/${issue.id}`, "PATCH", { lane: "in_progress" });
  expect((await history()).history).toHaveLength(2);
  await call(path, "PUT", { issueIds: [issue.id], lane: "done" });
  await call(path, "PUT", { issueIds: [issue.id], lane: "done" });
  await call(`${path}/reorder`, "POST", { issueIds: [issue.id], lane: "todo", beforeIssueId: null });
  await call(`${path}/reorder`, "POST", { issueIds: [issue.id], lane: "todo", beforeIssueId: null });
  expect((await history()).history).toHaveLength(4);
  await call(`${path}/${issue.id}`, "DELETE");
  await call(path, "POST", { issueIds: [issue.id], lane: "todo" });
  expect((await history()).history).toHaveLength(6);
  const user = app.db.query("SELECT id FROM users").get() as { id: string };
  for (const [route, data] of [["/api/issues/labels", { labels: ["bug"] }], ["/api/issues/tagged-users", { userIds: [user.id] }]] as const) {
    await call(route, "POST", { issueIds: [issue.id], ...data });
    await call(route, "POST", { issueIds: [issue.id], ...data });
  }
  expect((await history()).history).toHaveLength(8);
  const before = await history();
  const oldBody = (await call(`/api/issues/${issue.id}`)).issue.body;
  expect((await request("/api/issues/labels", "POST", { issueIds: [issue.id, "999999"], labels: ["rollback"] })).status).toBe(404);
  expect((await call(`/api/issues/${issue.id}`)).issue.body).toBe(oldBody);
  expect(await history()).toEqual(before);
  const { issue: second } = await call("/api/issues", "POST", { body: "Second", projectId: project.id });
  expect((await request(path, "POST", { issueIds: [second.id, issue.id], lane: "todo" })).status).toBe(409);
  expect((await call(`/api/issues/${second.id}/history`)).history).toHaveLength(1);
  expect((await call(`/api/projects/${project.slug}/board`)).board.cards).toHaveLength(1);
  // A history insert failure must also roll back the corresponding issue mutation.
  app.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON issue_history BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  expect((await request(`/api/issues/${issue.id}`, "PATCH", { body: "must rollback" })).status).not.toBe(200);
  expect((await call(`/api/issues/${issue.id}`)).issue.body).toBe(oldBody);
  expect(await history()).toEqual(before);
  app.db.exec("DROP TRIGGER fail_history");
});

test("favorites are idempotent, private, CSRF protected and retained for archived projects", async () => {
  const { request, call, project, cookie } = await fixture();
  const path = `/api/me/favorite-projects/${project.id}`;
  expect(await call("/api/me/favorite-projects")).toEqual({ projectIds: [] });
  for (let i = 0; i < 2; i++) expect(await call(path, "PUT")).toEqual({ projectIds: [project.id] });
  await call("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password: "long-password-123" });
  const login = await request("/api/auth/login", "POST", { email: "member@example.com", password: "long-password-123" }, "");
  const memberCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(await (await request("/api/me/favorite-projects", "GET", undefined, memberCookie)).json()).toEqual({ projectIds: [] });
  await request(path, "DELETE", undefined, memberCookie);
  expect(await call("/api/me/favorite-projects")).toEqual({ projectIds: [project.id] });
  expect((await request(path, "PUT", undefined, "")).status).toBe(401);
  expect((await request(path, "DELETE", undefined, cookie, "https://evil.example")).status).toBe(403);
  for (const method of ["PUT", "DELETE"]) expect((await request("/api/me/favorite-projects/missing", method)).status).toBe(404);
  await call(`/api/projects/${project.slug}`, "PATCH", { archived: true });
  expect(await call("/api/me/favorite-projects")).toEqual({ projectIds: [project.id] });
  for (let i = 0; i < 2; i++) expect(await call(path, "DELETE")).toEqual({ projectIds: [] });
  expect(await call(path, "PUT")).toEqual({ projectIds: [project.id] });
});

test("migration 12 is additive, preserves events across replay/reopen, and supports old target versions", async () => {
  const { app, dir, call, project, issue } = await fixture();
  await call(`/api/me/favorite-projects/${project.id}`, "PUT");
  const saved = app.db.query("SELECT * FROM issue_history").all();
  app.db.exec("DELETE FROM migrations WHERE version=12");
  const reopened = openDatabase(join(dir, "app.sqlite"));
  expect(reopened.query("SELECT * FROM issue_history").all()).toEqual(saved);
  expect(reopened.query("SELECT * FROM favorite_projects").all()).toHaveLength(1);
  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  reopened.close();
  for (const version of [10, 11] as const) {
    const path = join(dir, `legacy-${version}.sqlite`);
    const old = openDatabase(path, version);
    expect(old.query("SELECT name FROM sqlite_schema WHERE name='issue_history'").get()).toBeNull();
    old.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES ('legacy-user','Old','old@example.com','admin','old');`);
    if (version === 10) old.exec(`INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES ('legacy-id',1,NULL,'Old','# Old','backlog','none','[]','legacy-user','old','old');`);
    else old.exec(`INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,NULL,'Old','# Old','backlog','none','[]','legacy-user','old','old');`);
    old.close();
    const upgraded = openDatabase(path);
    expect(upgraded.query("SELECT * FROM issue_history").all()).toEqual([]);
    expect(upgraded.query("SELECT body FROM issues").all()).toEqual([{ body: "# Old" }]);
    expect(upgraded.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 12 });
    upgraded.close();
  }
  expect(issue.id).toBe("1");
});
