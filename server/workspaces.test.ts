import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const e of owned.splice(0)) { e.app?.close(); rmSync(e.dir, { recursive: true, force: true }); } });
function directory() { const e = { dir: mkdtempSync(join(tmpdir(), "workspaces-")), app: undefined as ReturnType<typeof createApp> | undefined }; owned.push(e); return e; }
async function fixture() {
  const e = directory(), app = e.app = createApp({ dataDir: e.dir });
  const request = (cookie: string, scope: string | undefined, path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json", ...(scope === undefined ? {} : { "X-Workspace-Slug": scope }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (cookie: string, scope: string | undefined, path: string, method = "GET", body?: unknown) => {
    const response = await request(cookie, scope, path, method, body);
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const password = "workspace-test-password";
  const setup = await request("", undefined, "/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  const adminId = (await setup.json()).user.id;
  const addUser = async (email: string) => {
    const { user } = await call(admin, undefined, "/api/admin/users", "POST", { name: email, email, password });
    const login = await request("", undefined, "/api/auth/login", "POST", { email, password });
    return { ...user, cookie: login.headers.get("set-cookie")!.split(";")[0]! };
  };
  const owner = await addUser("owner@example.com"), reader = await addUser("reader@example.com");
  const workspace = async (slug: string, visibility = "public") => (await call(owner.cookie, undefined, "/api/workspaces", "POST", { name: slug, slug, visibility })).workspace;
  const project = async (scope: string, slug = "same") => (await call(owner.cookie, scope, "/api/projects", "POST", { name: slug, slug })).project;
  const issue = async (scope: string, projectId: string | null = null, extra = {}) => (await call(owner.cookie, scope, "/api/issues", "POST", { body: "# Sample", projectId, ...extra })).issue;
  const invite = async (scope: string, email: string, defaultAccess = "none", projectAccess: any[] = []) => call(owner.cookie, undefined, `/api/workspaces/${scope}/invitations`, "POST", { email, defaultAccess, projectAccess });
  return { app, e, request, call, admin, adminId, owner, reader, addUser, workspace, project, issue, invite };
}

test("workspace discovery is not content access; hidden workspaces, creation setting and admin override", async () => {
  const f = await fixture();
  const listed = await f.workspace("listed"), hidden = await f.workspace("hidden", "hidden");
  const p = await f.project("listed"), i = await f.issue("listed", p.id);
  const listing = await f.call(f.reader.cookie, undefined, "/api/workspaces");
  expect(listing.allowUserWorkspaceCreation).toBe(true);
  expect(listing.workspaces.find((w: any) => w.slug === "listed")).toMatchObject({ role: null, defaultAccess: "none", canManage: false });
  expect(listing.workspaces.some((w: any) => w.slug === "hidden")).toBe(false);
  expect((await f.call(f.reader.cookie, "listed", "/api/projects")).projects).toEqual([]);
  expect((await f.call(f.reader.cookie, "listed", "/api/issues")).issues).toEqual([]);
  for (const path of ["/api/users", `/api/issues/${i.id}`, `/api/projects/${p.slug}`]) expect((await f.request(f.reader.cookie, "listed", path)).status).toBe(404);
  expect((await f.request(f.reader.cookie, undefined, "/api/workspaces/hidden")).status).toBe(404);
  expect((await f.request(f.reader.cookie, "hidden", "/api/projects")).status).toBe(404);
  expect((await f.call(f.admin, undefined, "/api/admin/workspaces")).workspaces.map((w: any) => w.id)).toContain(hidden.id);
  expect((await f.call(f.admin, undefined, "/api/workspaces/hidden")).workspace.canManage).toBe(true);
  await f.call(f.admin, undefined, "/api/workspaces/hidden", "PATCH", { name: "Managed" });
  await f.call(f.admin, undefined, "/api/admin/workspace-settings", "PATCH", { allowUserWorkspaceCreation: false });
  expect((await f.request(f.reader.cookie, undefined, "/api/workspaces", "POST", { name: "No", slug: "no", visibility: "public" })).status).toBe(403);
  expect((await f.request(f.reader.cookie, undefined, "/api/admin/workspace-settings", "PATCH", { allowUserWorkspaceCreation: true })).status).toBe(403);
  expect((await f.call(f.admin, undefined, "/api/workspaces", "POST", { name: "Yes", slug: "yes", visibility: "hidden" })).workspace.canManage).toBe(true);
  expect(listed.id).not.toBe(hidden.id);
});

test("numbers are scoped, slugs repeat, direct/list/reference/history/relationship/duplicate operations isolate workspaces", async () => {
  const f = await fixture();
  await f.workspace("one"); await f.workspace("two");
  const p = await f.project("one"), q = await f.project("two");
  const a = await f.issue("one", p.id), b = await f.issue("two", q.id), c = await f.issue("one");
  expect(a.number).toBe(1); expect(b.number).toBe(1); expect(c.number).toBe(2); expect(a.id).not.toBe(b.id);
  expect(a).toMatchObject({ workspaceSlug: "one", workspaceId: p.workspaceId, access: "full" });
  expect(p).toMatchObject({ slug: q.slug, workspaceSlug: "one", access: "full" });
  expect((await f.call(f.owner.cookie, "two", "/api/issues/by-number/1")).issue.id).toBe(b.id);
  expect((await f.call(f.owner.cookie, "two", "/api/issues/references?q=!1")).issues).toEqual([expect.objectContaining({ id: b.id, number: 1 })]);
  expect((await f.call(f.owner.cookie, "two", `/api/projects/${p.slug}`)).project.id).toBe(q.id);
  for (const auth of [f.owner.cookie, f.admin]) {
    for (const suffix of ["", "/history", "/relationships", "/external-links"]) expect((await f.request(auth, "two", `/api/issues/${a.id}${suffix}`)).status).toBe(404);
    expect((await f.request(auth, "two", `/api/issues/${b.id}`, "PATCH", { projectId: p.id })).status).toBe(404);
    expect((await f.request(auth, "two", `/api/issues/${b.id}/sub-issues`, "POST", { issueId: a.id })).status).toBe(404);
    expect((await f.request(auth, "two", `/api/issues/${b.id}/close`, "POST", { reason: "duplicate", duplicateOfId: a.id })).status).toBe(404);
  }
  await f.call(f.owner.cookie, "one", `/api/issues/${a.id}/sub-issues`, "POST", { issueId: c.id });
  expect((await f.call(f.owner.cookie, "one", `/api/issues/${a.id}/relationships`)).subIssues[0]).toMatchObject({ id: c.id, number: 2 });
  const d = await f.issue("two", null, { state: "draft" });
  expect((await f.request(f.admin, "two", `/api/issues/by-number/${d.number}`)).status).toBe(404);
  expect((await f.call(f.owner.cookie, "two", "/api/issues")).issues.map((i: any) => i.id)).toEqual([b.id, d.id]);
  expect((await f.call(f.owner.cookie, undefined, "/api/issues")).issues).toEqual([]);
});

test("specific grants replace defaults both directions, apply to future projects, and reject every read-only mutation", async () => {
  const f = await fixture(); await f.workspace("permissions");
  const p = await f.project("permissions", "read"), q = await f.project("permissions", "write");
  const a = await f.issue("permissions", p.id), b = await f.issue("permissions", q.id), unlinked = await f.issue("permissions");
  await f.invite("permissions", f.reader.email, "none", [{ projectId: p.id, access: "read" }, { projectId: q.id, access: "full" }]);
  await f.call(f.reader.cookie, undefined, "/api/workspaces");
  expect((await f.call(f.reader.cookie, "permissions", "/api/issues")).issues.map((i: any) => i.id)).toEqual([a.id, b.id]);
  expect((await f.request(f.reader.cookie, "permissions", `/api/issues/${unlinked.id}`)).status).toBe(404);
  expect((await f.call(f.reader.cookie, "permissions", `/api/issues/${a.id}`)).issue.access).toBe("read");
  await f.call(f.reader.cookie, "permissions", `/api/issues/${b.id}`, "PATCH", { body: "Allowed" });
  const path = `/api/projects/${p.slug}`, issuePath = `/api/issues/${a.id}`;
  const mutations: [string, string, unknown?][] = [
    ["PATCH", path, { name: "No" }], ["PATCH", path, { archived: true }], ["PATCH", `${path}/access`, { visibility: "private" }],
    ["PATCH", `${path}/board`, { lanes: ["todo"] }], ["PATCH", `${path}/board/lanes/todo`, { index: 1 }], ["DELETE", `${path}/board/lanes/todo`],
    ["POST", `${path}/issues`, { body: "No" }], ["POST", "/api/issues", { projectId: p.id, body: "No" }],
    ["POST", `${path}/board/issues`, { issueIds: [a.id], lane: "todo" }], ["PUT", `${path}/board/issues`, { issueIds: [a.id], lane: "todo" }],
    ["POST", `${path}/board/issues/reorder`, { issueIds: [a.id], lane: "todo", beforeIssueId: null }],
    ["PATCH", `${path}/board/issues/${a.id}`, { lane: "done" }], ["DELETE", `${path}/board/issues/${a.id}`],
    ["PATCH", issuePath, { body: "No" }], ["PATCH", issuePath, { state: "closed" }], ["PATCH", issuePath, { projectId: q.id }],
    ["POST", `${issuePath}/close`, { reason: "completed" }], ["POST", `${issuePath}/comments`, { body: "No" }],
    ["POST", "/api/issues/labels", { issueIds: [a.id], labels: ["bug"] }],
    ["POST", "/api/issues/tagged-users", { issueIds: [a.id], userIds: [f.reader.id] }],
    ["POST", `${issuePath}/sub-issues`, { issueId: b.id }], ["DELETE", `${issuePath}/sub-issues/${b.id}`],
  ];
  for (const [method, path, body] of mutations) expect((await f.request(f.reader.cookie, "permissions", path, method, body)).status).toBe(403);
  await f.call(f.reader.cookie, "permissions", `/api/me/pinned-projects/${p.id}`, "PUT");
  const update = (defaultAccess: string, projectAccess: any[]) => f.call(f.owner.cookie, undefined, `/api/workspaces/permissions/members/${f.reader.id}`, "PATCH", { defaultAccess, projectAccess });
  await update("full", [{ projectId: p.id, access: "read" }]);
  expect((await f.request(f.reader.cookie, "permissions", issuePath, "PATCH", { body: "Still no" })).status).toBe(403);
  const future = await f.project("permissions", "future");
  expect((await f.call(f.reader.cookie, "permissions", `/api/projects/${future.slug}`)).project.access).toBe("full");
  await update("read", [{ projectId: q.id, access: "full" }]);
  await f.call(f.reader.cookie, "permissions", `/api/issues/${b.id}`, "PATCH", { body: "Full override" });
  expect((await f.request(f.reader.cookie, "permissions", "/api/issues", "POST", { body: "No unlinked write" })).status).toBe(403);
  await update("read", []);
  expect((await f.request(f.reader.cookie, "permissions", "/api/uploads", "POST")).status).toBe(403);
  expect((await f.request(f.reader.cookie, "permissions", "/api/projects", "POST", { name: "No" })).status).toBe(403);
});

test("invitations accept current verified email, future accounts, revocation and hidden Default onboarding", async () => {
  const f = await fixture(); await f.workspace("secret", "hidden");
  const { invitation } = await f.invite("secret", "future@example.com", "read");
  expect(invitation).toMatchObject({ email: "future@example.com", defaultAccess: "read", projectAccess: [] });
  const future = await f.addUser("future@example.com");
  expect((await f.call(f.owner.cookie, undefined, "/api/workspaces/secret/members")).invitations).toHaveLength(1);
  const listing = await f.call(future.cookie, undefined, "/api/workspaces");
  expect(listing.workspaces.find((w: any) => w.slug === "secret")).toMatchObject({ role: "member", defaultAccess: "read" });
  expect((await f.call(f.owner.cookie, undefined, "/api/workspaces/secret/members")).invitations).toEqual([]);
  await f.call(f.owner.cookie, undefined, `/api/workspaces/secret/members/${future.id}`, "DELETE");
  expect((await f.request(future.cookie, "secret", "/api/issues")).status).toBe(404);
  await f.invite("secret", f.reader.email, "full");
  f.app.db.query("DELETE FROM verified_account_emails WHERE userId=?").run(f.reader.id);
  expect((await f.call(f.reader.cookie, undefined, "/api/workspaces")).workspaces.some((w: any) => w.slug === "secret")).toBe(false);
  f.app.db.query("INSERT INTO verified_account_emails VALUES (?,?)").run(f.reader.id, "old@example.com");
  expect((await f.call(f.reader.cookie, undefined, "/api/workspaces")).workspaces.some((w: any) => w.slug === "secret")).toBe(false);
  f.app.db.query("UPDATE verified_account_emails SET email=? WHERE userId=?").run(f.reader.email, f.reader.id);
  expect((await f.call(f.reader.cookie, undefined, "/api/workspaces")).workspaces.some((w: any) => w.slug === "secret")).toBe(true);
  const pending = await f.invite("secret", "cancel@example.com");
  await f.call(f.owner.cookie, undefined, `/api/workspaces/secret/invitations/${pending.invitation.id}`, "DELETE");
  expect((await f.request(f.owner.cookie, undefined, `/api/workspaces/secret/members/${f.owner.id}`, "DELETE")).status).toBe(409);
  await f.call(f.admin, undefined, "/api/workspaces/default", "PATCH", { visibility: "hidden" });
  const outsider = await f.addUser("outsider@example.com");
  expect((await f.call(outsider.cookie, undefined, "/api/workspaces")).workspaces).toEqual([]);
  expect((await f.request(outsider.cookie, undefined, "/api/issues")).status).toBe(404);
  expect((await f.call(f.admin, undefined, "/api/admin/users")).users.map((u: any) => u.id)).toContain(outsider.id);
  expect((await f.request(outsider.cookie, undefined, "/api/admin/users")).status).toBe(403);
});

test("attachments, comment mutation, member directory, API keys and scoped project grants do not cross boundaries", async () => {
  const f = await fixture(); await f.workspace("files"); await f.workspace("elsewhere");
  const p = await f.project("files");
  const form = new FormData(); form.set("file", new File(["hello"], "test.txt"));
  const response = await f.app.request("/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000", Cookie: f.owner.cookie, "X-Workspace-Slug": "files" }, body: form });
  expect(response.status).toBe(200);
  const { attachment } = await response.json(); expect(attachment.url).toContain("?workspace=files");
  const a = await f.issue("files", p.id, { body: `# File\n[download](${attachment.url})` });
  const comment = (await f.call(f.owner.cookie, "files", `/api/issues/${a.id}/comments`, "POST", { body: "Comment" })).comment;
  await f.invite("files", f.reader.email, "read");
  await f.call(f.reader.cookie, undefined, "/api/workspaces");
  expect((await f.request(f.reader.cookie, undefined, attachment.url)).status).toBe(200);
  expect((await f.request(f.admin, "elsewhere", attachment.url)).status).toBe(404);
  expect((await f.request(f.owner.cookie, "elsewhere", "/api/issues", "POST", { body: `[cross](${attachment.url})` })).status).toBe(404);
  expect((await f.request(f.owner.cookie, "elsewhere", `/api/comments/${comment.id}`, "PATCH", { body: "No" })).status).toBe(404);
  const directory = (await f.call(f.reader.cookie, "files", "/api/users")).users;
  expect(directory.map((u: any) => u.id).sort()).toEqual([f.owner.id, f.reader.id].sort());
  expect((await f.request(f.owner.cookie, "files", "/api/issues", "POST", { body: `[@Admin](mention:${f.adminId})` })).status).toBe(400);
  const external = await f.project("elsewhere");
  expect((await f.request(f.owner.cookie, undefined, `/api/workspaces/files/members/${f.reader.id}`, "PATCH", { defaultAccess: "full", projectAccess: [{ projectId: external.id, access: "read" }] })).status).toBe(400);
  const key = (await f.call(f.reader.cookie, undefined, "/api/me/api-keys", "POST", { name: "Discovery", scopes: ["read"], expiresInDays: 1 })).token;
  const bearer = (path: string, method = "GET", body?: unknown) => f.app.request(path, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Workspace-Slug": "files" }, body: body ? JSON.stringify(body) : undefined });
  expect((await bearer("/api/workspaces")).status).toBe(200);
  expect((await bearer("/api/workspaces/files")).status).toBe(200);
  expect((await bearer("/api/workspaces/files/members")).status).toBe(403);
  expect((await bearer("/api/workspaces/files", "PATCH", { name: "No" })).status).toBe(403);
});

test("v22 migration preserves IDs, numbers, drafts, relationships, attachments, boards, history and private protections", async () => {
  const e = directory(), path = join(e.dir, "app.sqlite");
  const old = openDatabase(path, 21);
  old.exec(`
    INSERT INTO users VALUES ('admin','Admin','admin@example.com','admin','time',NULL),('member','Member','member@example.com','member','time',NULL);
    INSERT INTO projects (id,slug,name,description,createdAt,visibility,ownerId) VALUES ('p','same','Legacy','description','time','private','admin');
    INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt,isDraft) VALUES
      (17,17,'p','Parent','Parent','todo','none','[]','admin','time','time',0),
      (35,35,'p','Child','Child','todo','none','[]','admin','time','time',0),
      (42,42,NULL,'Draft','Draft','todo','none','[]','member','time','time',1);
    INSERT INTO issue_relationships VALUES (35,17);
    INSERT INTO comments VALUES ('c','17','admin','Comment','time','time');
    INSERT INTO attachments (id,name,mime,size,uploaderId) VALUES ('file','file','text/plain',3,'admin');
    INSERT INTO issue_attachments VALUES (17,'file');
    INSERT INTO issue_history (issueId,actorId,createdAt,action,changes) VALUES ('17','admin','time','created','[]');
    INSERT INTO board_issues VALUES ('p','17','todo',7);
    INSERT INTO favorite_projects VALUES ('admin','p',3);
    CREATE INDEX retained_project_index ON projects(name);
    CREATE TRIGGER retained_project_trigger BEFORE UPDATE OF description ON projects BEGIN SELECT RAISE(ABORT,'preserved'); END;
  `);
  const tables = ["issues", "projects", "comments", "attachments", "issue_attachments", "issue_relationships", "issue_history", "board_issues", "favorite_projects"];
  const before = Object.fromEntries(tables.map((table) => [table, old.query(`SELECT * FROM ${table}`).all()]));
  old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase(path);
    for (const table of tables) expect(db.query(`SELECT * FROM ${table}`).all()).toEqual(before[table]!.map((row: any) => ["issues", "projects", "attachments"].includes(table) ? { ...row, workspaceId: "default", ...(table === 'projects' ? { creatorId: row.ownerId } : {}) } : row));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT nextIssueNumber FROM workspaces WHERE id='default'").get()).toEqual({ nextIssueNumber: 43 });
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_members").get()).toEqual({ count: 2 });
    expect(() => db.exec("UPDATE projects SET description='changed' WHERE id='p'")).toThrow("preserved");
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='retained_project_index'").get()).not.toBeNull();
    db.close();
  }
  e.app = createApp({ dataDir: e.dir });
  for (const userId of ["admin", "member"]) {
    const hash = new Bun.CryptoHasher("sha256").update(userId).digest("hex");
    e.app.db.query("INSERT INTO sessions VALUES (?,?,?)").run(hash, userId, Date.now() + 60000);
  }
  expect((await e.app.request("/api/issues/17", { headers: { Cookie: "session=member" } })).status).toBe(404);
  expect((await e.app.request("/api/issues/42", { headers: { Cookie: "session=admin" } })).status).toBe(404);
  const next = await e.app.request("/api/issues", { method: "POST", headers: { Cookie: "session=admin", Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ body: "Next" }) });
  expect(next.status).toBe(200); expect((await next.json()).issue.number).toBe(43);
});

test("Default pending invitations override compatibility onboarding, including unverified future accounts", async () => {
  const f = await fixture();
  await f.call(f.admin, undefined, "/api/workspaces/default/invitations", "POST", { email: "limited@example.com", defaultAccess: "read", projectAccess: [] });
  const limited = await f.addUser("limited@example.com");
  expect(f.app.db.query("SELECT 1 FROM workspace_members WHERE workspaceId='default' AND userId=?").get(limited.id)).toBeNull();
  await f.call(limited.cookie, undefined, "/api/workspaces");
  expect(f.app.db.query("SELECT defaultAccess,legacyAccess FROM workspace_members WHERE workspaceId='default' AND userId=?").get(limited.id)).toEqual({ defaultAccess: "read", legacyAccess: 0 });
  expect((await f.request(limited.cookie, undefined, "/api/issues", "POST", { body: "Cannot write" })).status).toBe(403);
  await f.call(f.admin, undefined, "/api/workspaces/default/invitations", "POST", { email: "unverified@example.com", defaultAccess: "none", projectAccess: [] });
  const uid = crypto.randomUUID();
  f.app.db.query("INSERT INTO users VALUES (?,?,?,'member','time',NULL)").run(uid, "Unverified", "unverified@example.com");
  const hash = new Bun.CryptoHasher("sha256").update(uid).digest("hex");
  f.app.db.query("INSERT INTO sessions VALUES (?,?,?)").run(hash, uid, Date.now() + 60000);
  const cookie = `session=${uid}`;
  expect((await f.call(cookie, undefined, "/api/workspaces")).workspaces.find((w: any) => w.slug === "default").role).toBeNull();
  expect((await f.request(cookie, undefined, "/api/issues", "POST", { body: "Cannot write" })).status).toBe(404);
  expect(f.app.db.query("SELECT 1 FROM workspace_invitations WHERE email='unverified@example.com'").get()).not.toBeNull();
});

test("unchanged legacy membership edits preserve private projects, explicit conversion requires confirmation", async () => {
  const f = await fixture();
  const p = (await f.call(f.owner.cookie, undefined, "/api/projects", "POST", { name: "Private", visibility: "private" })).project;
  const members = (await f.call(f.admin, undefined, "/api/workspaces/default/members")).members;
  expect(members.find((m: any) => m.userId === f.reader.id).legacyAccess).toBe(true);
  const path = `/api/workspaces/default/members/${f.reader.id}`;
  const unchanged = await f.call(f.admin, undefined, path, "PATCH", { defaultAccess: "full", projectAccess: [] });
  expect(unchanged.member.legacyAccess).toBe(true);
  expect((await f.request(f.reader.cookie, undefined, `/api/projects/${p.slug}`)).status).toBe(404);
  expect((await f.request(f.admin, undefined, path, "PATCH", { defaultAccess: "read", projectAccess: [] })).status).toBe(409);
  expect((await f.request(f.reader.cookie, undefined, `/api/projects/${p.slug}`)).status).toBe(404);
  const converted = await f.call(f.admin, undefined, path, "PATCH", { defaultAccess: "read", projectAccess: [], convertLegacyAccess: true });
  expect(converted.member.legacyAccess).toBe(false);
  expect((await f.call(f.reader.cookie, undefined, `/api/projects/${p.slug}`)).project.access).toBe("read");
});

test("configured v22 workspace retains legacy IDs, content, attachments, relations and omitted-header compatibility", async () => {
  const e = directory(), path = join(e.dir, "app.sqlite");
  const old = openDatabase(path, 21);
  const fileId = crypto.randomUUID();
  old.exec(`INSERT INTO users VALUES ('admin','Admin','admin@example.com','admin','time',NULL);
    INSERT INTO projects (id,slug,name,description,createdAt,visibility,ownerId) VALUES ('p','legacy','Legacy','','time','private','admin');
    INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt,isDraft) VALUES
      (11,11,'p','Parent','Parent','todo','none','[]','admin','time','time',0),
      (19,19,'p','Child','Child','todo','none','[]','admin','time','time',0),
      (24,24,NULL,'Draft','Draft','todo','none','[]','admin','time','time',1);
    INSERT INTO issue_relationships VALUES (19,11);
    INSERT INTO comments VALUES ('c','11','admin','Comment','time','time');
    INSERT INTO issue_history (issueId,actorId,createdAt,action,changes) VALUES ('11','admin','time','created','[]');
    INSERT INTO board_issues VALUES ('p','11','todo',7);`);
  const body = `Parent\n[attachment](/api/uploads/${fileId}/legacy.txt)`;
  old.query("UPDATE issues SET body=? WHERE id=11").run(body);
  old.query("INSERT INTO attachments (id,name,mime,size,uploaderId) VALUES (?,'legacy.txt','text/plain',6,'admin')").run(fileId);
  old.query("INSERT INTO issue_attachments VALUES (11,?)").run(fileId);
  const tables = ["issues", "projects", "attachments", "comments", "issue_relationships", "issue_history", "board_issues", "issue_attachments"];
  const rows = Object.fromEntries(tables.map(table => [table, old.query(`SELECT * FROM ${table}`).all()]));
  old.close();
  mkdirSync(join(e.dir, "uploads")); writeFileSync(join(e.dir, "uploads", fileId), "legacy");
  e.app = createApp({ dataDir: e.dir, migrationWorkspaceName: "richie's workspace", migrationWorkspaceSlug: "richies-workspace" });
  const check = () => {
    expect(e.app!.db.query("SELECT id,name,slug FROM workspaces").all()).toEqual([{ id: "default", name: "richie's workspace", slug: "richies-workspace" }]);
    for (const table of tables) expect(e.app!.db.query(`SELECT * FROM ${table}`).all()).toEqual(rows[table]!.map((row: any) => ["issues", "projects", "attachments"].includes(table) ? { ...row, workspaceId: "default", ...(table === 'projects' ? { creatorId: row.ownerId } : {}) } : row));
    expect(e.app!.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readFileSync(join(e.dir, "uploads", fileId), "utf8")).toBe("legacy");
  };
  check(); e.app.close();
  e.app = createApp({ dataDir: e.dir, migrationWorkspaceName: "Ignored", migrationWorkspaceSlug: "ignored" }); check();
  const hash = new Bun.CryptoHasher("sha256").update("admin").digest("hex");
  e.app.db.query("INSERT INTO sessions VALUES (?,'admin',?)").run(hash, Date.now() + 60000);
  const headers = { Cookie: "session=admin" };
  const detail = await e.app.request("/api/issues/11", { headers });
  expect(detail.status).toBe(200);
  expect((await detail.json()).issue).toMatchObject({ id: "11", number: 11, body, workspaceId: "default", workspaceSlug: "richies-workspace" });
  expect((await (await e.app.request("/api/projects/legacy", { headers })).json()).project).toMatchObject({ workspaceId: "default", workspaceSlug: "richies-workspace", visibility: "private" });
  const upload = await e.app.request(`/api/uploads/${fileId}/legacy.txt`, { headers });
  expect(upload.status).toBe(200); expect(await upload.text()).toBe("legacy");
  expect((await e.app.request("/api/issues/11", { headers: { ...headers, "X-Workspace-Slug": "default" } })).status).toBe(404);
  expect((await e.app.request("/api/issues/by-number/11", { headers: { ...headers, "X-Workspace-Slug": "richies-workspace" } })).status).toBe(200);
  e.app.db.query("INSERT INTO users VALUES ('new','New','new@example.com','member','time',NULL)").run();
  expect(e.app.db.query("SELECT workspaceId FROM workspace_members WHERE userId='new'").get()).toEqual({ workspaceId: "default" });
});

test("migration config validates before any SQLite or app-file changes and env config initializes only once", () => {
  const e = directory(), path = join(e.dir, "fresh.sqlite");
  const invalid = [
    { workspaceSlug: "" }, { workspaceSlug: "Upper" }, { workspaceSlug: "-prefix" }, { workspaceSlug: "suffix-" },
    { workspaceSlug: "double--hyphen" }, { workspaceSlug: "with/slash" }, { workspaceSlug: " space " }, { workspaceSlug: "a".repeat(71) },
    { workspaceName: "" }, { workspaceName: "  " }, { workspaceName: "a".repeat(101) },
  ];
  for (const options of invalid) {
    expect(() => openDatabase(path, 22, options)).toThrow("MIGRATION_WORKSPACE_");
    expect(existsSync(path)).toBe(false);
    const appDir = join(e.dir, "app");
    expect(() => createApp({ dataDir: appDir, migrationWorkspaceName: options.workspaceName, migrationWorkspaceSlug: options.workspaceSlug })).toThrow("MIGRATION_WORKSPACE_");
    expect(existsSync(appDir)).toBe(false);
  }
  const legacy = openDatabase(path, 21); legacy.close();
  const bytes = readFileSync(path);
  expect(() => openDatabase(path, 22, { workspaceSlug: "invalid/slug" })).toThrow("MIGRATION_WORKSPACE_SLUG");
  expect(readFileSync(path)).toEqual(bytes);
  const beforeName = process.env.MIGRATION_WORKSPACE_NAME, beforeSlug = process.env.MIGRATION_WORKSPACE_SLUG;
  try {
    process.env.MIGRATION_WORKSPACE_NAME = "  richie's workspace  "; process.env.MIGRATION_WORKSPACE_SLUG = "richies-workspace";
    const appDir = join(e.dir, "from-env");
    e.app = createApp({ dataDir: appDir });
    expect(e.app.db.query("SELECT id,name,slug FROM workspaces").get()).toEqual({ id: "default", name: "richie's workspace", slug: "richies-workspace" });
    e.app.close();
    delete process.env.MIGRATION_WORKSPACE_NAME; delete process.env.MIGRATION_WORKSPACE_SLUG;
    e.app = createApp({ dataDir: appDir });
    expect(e.app.db.query("SELECT name,slug FROM workspaces").get()).toEqual({ name: "richie's workspace", slug: "richies-workspace" });
  } finally {
    if (beforeName === undefined) delete process.env.MIGRATION_WORKSPACE_NAME; else process.env.MIGRATION_WORKSPACE_NAME = beforeName;
    if (beforeSlug === undefined) delete process.env.MIGRATION_WORKSPACE_SLUG; else process.env.MIGRATION_WORKSPACE_SLUG = beforeSlug;
  }
});

