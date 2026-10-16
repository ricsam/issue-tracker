import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

// Exact per-run ownership manifest; never clean another test's directories.
const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const { dir, app } of owned.splice(0)) { app?.close(); rmSync(dir, { recursive: true, force: true }); } });
function directory() { const entry = { dir: mkdtempSync(join(tmpdir(), "issue-drafts-")), app: undefined as ReturnType<typeof createApp> | undefined }; owned.push(entry); return entry; }
async function fixture() {
  const entry = directory(), app = entry.app = createApp({ dataDir: entry.dir });
  const request = (auth: string, path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Origin: "http://localhost:3000", Cookie: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (auth: string, path: string, method = "GET", body?: unknown) => {
    const response = await request(auth, path, method, body); expect(response.status).toBe(200); return response.json();
  };
  const password = "long-password-123";
  const setup = await request("", "/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  expect(setup.status).toBe(200);
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  const users: { cookie: string; id: string }[] = [];
  for (const name of ["Creator", "Other"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const { user } = await call(admin, "/api/admin/users", "POST", { name, email, password });
    const login = await request("", "/api/auth/login", "POST", { email, password });
    expect(login.status).toBe(200);
    users.push({ id: user.id, cookie: login.headers.get("set-cookie")!.split(";")[0]! });
  }
  const [creator, other] = users as [typeof users[number], typeof users[number]];
  // The project owner is deliberately NOT the draft creator.
  const { project } = await call(other.cookie, "/api/projects", "POST", { name: "Shared project" });
  const path = `/api/projects/${project.slug}`;
  return { app, dir: entry.dir, call, request, admin, creator, other, project, path };
}

test("drafts are creator-only across project/workspace discovery, references, counts and recency, even for admins", async () => {
  const { call, request, admin, creator, other, project, path } = await fixture();
  const before = (await call(other.cookie, path)).project;
  const { issue: linked } = await call(creator.cookie, `${path}/issues`, "POST", { body: "# Secret linked #secret-tag", state: "draft" });
  const { issue: unlinked } = await call(creator.cookie, "/api/issues", "POST", { body: "# Secret workspace", state: "draft" });
  for (const draft of [linked, unlinked]) {
    expect(draft).toMatchObject({ state: "draft", authorId: creator.id, closedAt: null, closedById: null });
    expect(draft.isDraft).toBeUndefined();
    expect((await call(creator.cookie, `/api/issues/${draft.id}`)).issue).toEqual(draft);
    expect((await call(creator.cookie, `/api/issues/references?q=!${draft.id}`)).issues).toEqual([
      { id: draft.id, number: draft.number, title: draft.title, state: "draft" },
    ]);
    expect((await request("", `/api/issues/${draft.id}`)).status).toBe(401);
  }
  expect((await call(creator.cookie, "/api/issues")).issues.map((i: any) => i.id)).toEqual([linked.id, unlinked.id]);
  expect((await call(creator.cookie, `${path}/issues`)).issues.map((i: any) => i.id)).toEqual([linked.id]);
  expect((await call(creator.cookie, path)).project).toMatchObject({ issueCount: 1, lastIssueUpdatedAt: linked.updatedAt, openCount: 0 });
  for (const auth of [other.cookie, admin]) {
    expect((await call(auth, "/api/issues"))).toEqual({ issues: [], boards: {} });
    expect((await call(auth, `${path}/issues`))).toEqual({ issues: [] });
    expect((await call(auth, `${path}/board`)).board.cards).toEqual([]);
    expect((await call(auth, path)).project).toEqual(before);
    expect((await call(auth, "/api/projects")).projects.find((p: any) => p.id === project.id)).toEqual(before);
    for (const q of [linked.id, unlinked.id, "Secret"])
      expect((await call(auth, `/api/issues/references?q=${q}`)).issues).toEqual([]);
    for (const draft of [linked, unlinked]) for (const suffix of ["", "/history"])
      expect((await request(auth, `/api/issues/${draft.id}${suffix}`)).status).toBe(404);
  }
  // Being a site administrator does not make your own drafts public either.
  const { issue: adminDraft } = await call(admin, "/api/issues", "POST", { body: "Admin's draft", state: "draft" });
  expect((await request(creator.cookie, `/api/issues/${adminDraft.id}`)).status).toBe(404);
  await call(admin, `/api/issues/${adminDraft.id}`);
});

test("all direct and bulk mutation paths protect drafts, comments and history without partial writes", async () => {
  const { app, call, request, admin, creator, other, project, path } = await fixture();
  const { issue: draft } = await call(creator.cookie, `${path}/issues`, "POST", { body: "# Personal", state: "draft" });
  const { issue: published } = await call(other.cookie, `${path}/issues`, "POST", { body: "# Published" });
  const { comment } = await call(creator.cookie, `/api/issues/${draft.id}/comments`, "POST", { body: "Private note" });
  const before = app.db.query("SELECT * FROM issues ORDER BY id").all();
  const history = app.db.query("SELECT * FROM issue_history ORDER BY id").all();
  const i = `/api/issues/${draft.id}`, b = `${path}/board/issues`;
  const routes: [string, string, unknown?][] = [
    ["PATCH", i, { body: "Stolen" }], ["PATCH", i, { state: "open" }], ["PATCH", i, { state: "closed" }],
    ["PATCH", i, { projectId: null }], ["POST", `${i}/comments`, { body: "Intrusion" }],
    ["PATCH", `/api/comments/${comment.id}`, { body: "Intrusion" }], ["DELETE", `/api/comments/${comment.id}`],
    ["POST", "/api/issues/labels", { issueIds: [published.id, draft.id], labels: ["leaked"] }],
    ["POST", `${path}/issues/labels`, { issueIds: [published.id, draft.id], labels: ["leaked"] }],
    ["POST", "/api/issues/tagged-users", { issueIds: [published.id, draft.id], userIds: [other.id] }],
    ["POST", `${path}/issues/tag`, { issueIds: [published.id, draft.id], userIds: [other.id] }],
    ["POST", b, { issueIds: [published.id, draft.id], lane: "todo" }],
    ["PUT", b, { issueIds: [published.id, draft.id], lane: "todo" }],
    ["PATCH", `${b}/${draft.id}`, { lane: "done" }], ["DELETE", `${b}/${draft.id}`],
  ];
  for (const auth of [other.cookie, admin]) for (const [method, url, body] of routes)
    expect((await request(auth, url, method, body)).status).toBe(url === b ? 400 : 404);
  for (const method of ["POST", "PUT"]) {
    const hidden = await request(other.cookie, b, method, { issueIds: [draft.id], lane: "todo" });
    const absent = await request(other.cookie, b, method, { issueIds: ["999999"], lane: "todo" });
    expect(hidden.status).toBe(absent.status);
    expect(await hidden.json()).toEqual(await absent.json());
  }
  expect((await request(other.cookie, `${b}/reorder`, "POST", { issueIds: [draft.id], lane: "todo", beforeIssueId: null })).status).toBe(400);
  expect(app.db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(before);
  expect(app.db.query("SELECT * FROM issue_history ORDER BY id").all()).toEqual(history);
  expect(app.db.query("SELECT * FROM board_issues").all()).toEqual([]);
  expect((await call(creator.cookie, i)).comments).toEqual([comment]);
  expect(project.id).toBe(draft.projectId);
});

test("creator can edit, move and publish drafts; state and placement validation are atomic", async () => {
  const { app, call, request, admin, creator, other, project, path } = await fixture();
  for (const state of ["closed", "invalid", null, true])
    expect((await request(creator.cookie, "/api/issues", "POST", { body: "No", state })).status).toBe(400);
  for (const url of ["/api/issues", `${path}/issues`])
    expect((await request(creator.cookie, url, "POST", { body: "No", state: "draft", lane: "todo", ...(url === "/api/issues" ? { projectId: project.id } : {}) })).status).toBe(400);
  expect(app.db.query("SELECT * FROM issues").all()).toEqual([]);
  const { issue: draft } = await call(creator.cookie, "/api/issues", "POST", { body: "# Personal", state: "draft", projectId: project.id });
  const i = `/api/issues/${draft.id}`;
  for (const method of ["POST", "PUT"])
    expect((await request(creator.cookie, `${path}/board/issues`, method, { issueIds: [draft.id], lane: "todo" })).status).toBe(409);
  const original = await call(creator.cookie, i), history = await call(creator.cookie, `${i}/history`);
  expect((await request(creator.cookie, i, "PATCH", { state: "closed", body: "Should roll back" })).status).toBe(409);
  expect(await call(creator.cookie, i)).toEqual(original);
  expect(await call(creator.cookie, `${i}/history`)).toEqual(history);
  await call(creator.cookie, i, "PATCH", { body: "# Revised", state: "draft", projectId: null });
  expect((await call(creator.cookie, i)).issue).toMatchObject({ body: "# Revised", state: "draft", projectId: null });
  expect((await request(other.cookie, i)).status).toBe(404);
  const { issue: published } = await call(creator.cookie, i, "PATCH", { state: "open", projectId: project.id });
  expect(published).toMatchObject({ id: draft.id, state: "open", closedAt: null, closedById: null, authorId: creator.id, body: "# Revised", createdAt: draft.createdAt });
  for (const auth of [other.cookie, admin]) {
    expect((await call(auth, i)).issue).toEqual(published);
    expect((await call(auth, `${path}/issues`)).issues).toEqual([published]);
    expect((await call(auth, path)).project).toMatchObject({ issueCount: 1, lastIssueUpdatedAt: published.updatedAt });
  }
  const events = (await call(other.cookie, `${i}/history`)).history;
  expect(events[0].changes).toContainEqual({ field: "state", before: "draft", after: "open" });
  expect(events.at(-1).changes).toContainEqual({ field: "state", before: null, after: "draft" });
  await call(creator.cookie, i, "PATCH", { state: "open" });
  expect((await call(creator.cookie, `${i}/history`)).history).toEqual(events);
  await call(other.cookie, `${path}/board/issues`, "PUT", { issueIds: [draft.id], lane: "todo" });
  for (const state of ["open", "closed"]) {
    await call(other.cookie, i, "PATCH", { state });
    expect((await request(creator.cookie, i, "PATCH", { state: "draft" })).status).toBe(409);
  }
  expect((await call(other.cookie, `${path}/board`)).board.cards).toEqual([{ issueId: draft.id, lane: "todo" }]);
});

test("drafts continue to respect project ACL, transfer, revocation and archive rules", async () => {
  const { call, request, admin, creator, other, project, path } = await fixture();
  await call(other.cookie, `${path}/access`, "PATCH", { visibility: "private", sharedUserIds: [creator.id] });
  const { issue: draft } = await call(creator.cookie, `${path}/issues`, "POST", { body: "Private project draft", state: "draft" });
  const i = `/api/issues/${draft.id}`;
  await call(other.cookie, `${path}/access`, "PATCH", { sharedUserIds: [] });
  for (const auth of [creator.cookie, other.cookie, admin]) expect((await request(auth, i)).status).toBe(404);
  expect((await call(creator.cookie, "/api/issues")).issues).toEqual([]);
  await call(other.cookie, `${path}/access`, "PATCH", { ownerId: creator.id });
  await call(creator.cookie, i);
  await call(creator.cookie, path, "PATCH", { archived: true });
  expect((await request(creator.cookie, i, "PATCH", { state: "open" })).status).toBe(409);
  await call(creator.cookie, `${i}/history`);
  expect((await request(admin, i)).status).toBe(404);
  await call(creator.cookie, path, "PATCH", { archived: false });
  await call(creator.cookie, i, "PATCH", { state: "open" });
  expect((await request(other.cookie, i)).status).toBe(404); // Not shared after transfer.
  await call(admin, i);
  expect((await call(creator.cookie, path)).project.issueCount).toBe(1);
  expect(project.id).toBe(draft.projectId);
});

test("draft attachments, including retained comment/body history, have no admin bypass or URL laundering", async () => {
  const { app, call, request, admin, creator, other } = await fixture();
  const upload = async () => {
    const form = new FormData(); form.append("file", new File(["private attachment"], "secret.txt"));
    const response = await app.request("/api/uploads", { method: "POST", headers: { Cookie: creator.cookie, Origin: "http://localhost:3000" }, body: form });
    expect(response.status).toBe(200); return (await response.json()).attachment.url as string;
  };
  const url = await upload(), commentUrl = await upload();
  const { issue: draft } = await call(creator.cookie, "/api/issues", "POST", { body: `# Personal\n[file](${url})`, state: "draft" });
  const i = `/api/issues/${draft.id}`;
  const { comment } = await call(creator.cookie, `${i}/comments`, "POST", { body: `[note](${commentUrl})` });
  await call(creator.cookie, i, "PATCH", { body: "# Personal without current link" });
  await call(creator.cookie, `/api/comments/${comment.id}`, "DELETE");
  for (const file of [url, commentUrl]) {
    expect((await request(creator.cookie, file)).status).toBe(200);
    expect((await request("", file)).status).toBe(401);
    for (const auth of [admin, other.cookie]) {
      expect((await request(auth, file)).status).toBe(404);
      expect((await request(auth, "/api/issues", "POST", { body: `[stolen](${file})` })).status).toBe(404);
    }
  }
  await call(creator.cookie, i, "PATCH", { state: "open" });
  for (const file of [url, commentUrl]) for (const auth of [admin, other.cookie])
    expect((await request(auth, file)).status).toBe(200);
});

test("migration 17 preserves existing issues, child data and timestamps and survives reopening", () => {
  const { dir } = directory(), path = join(dir, "app.sqlite"), old = openDatabase(path, 16);
  old.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES ('author','Author','a@example.com','admin','old');
    INSERT INTO projects (id,slug,name,description,createdAt) VALUES ('p','p','Project','','old');
    INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,'p','Keep','# Keep','backlog','none','[]','author','created','updated');
    INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt,closedAt,closedById) VALUES (2,NULL,'Closed','# Closed','backlog','none','[]','author','created','updated','closed','author');
    INSERT INTO board_issues (projectId,issueId,lane,position) VALUES ('p','1','todo',9);
    INSERT INTO comments VALUES ('c','1','author','Note','created','updated');`);
  const rows = old.query("SELECT * FROM issues ORDER BY id").all();
  const cards = old.query("SELECT * FROM board_issues").all(), comments = old.query("SELECT * FROM comments").all();
  old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase(path);
    try {
      expect(db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(rows.map((row: any) => ({ ...row, isDraft: 0 })));
      expect(db.query("SELECT * FROM board_issues").all()).toEqual(cards);
      expect(db.query("SELECT * FROM comments").all()).toEqual(comments);
      expect(db.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 20 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => db.exec("UPDATE issues SET isDraft=1 WHERE id=2")).toThrow();
    } finally { db.close(); }
  }
});
