import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const { dir, app } of owned.splice(0)) { app?.close(); rmSync(dir, { recursive: true, force: true }); } });
function directory() { const entry = { dir: mkdtempSync(join(tmpdir(), "project-access-")), app: undefined as ReturnType<typeof createApp> | undefined }; owned.push(entry); return entry; }
async function fixture() {
  const entry = directory();
  const app = entry.app = createApp({ dataDir: entry.dir });
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
  const adminId = (await setup.json()).user.id as string;
  const members = [] as { cookie: string; id: string }[];
  for (const name of ["Owner", "Shared", "Other"]) {
    const email = `${name.toLowerCase()}@example.com`;
    const { user } = await call(admin, "/api/admin/users", "POST", { name, email, password });
    const login = await request("", "/api/auth/login", "POST", { email, password });
    expect(login.status).toBe(200);
    members.push({ id: user.id, cookie: login.headers.get("set-cookie")!.split(";")[0]! });
  }
  const [owner, shared, other] = members as [typeof members[number], typeof members[number], typeof members[number]];
  const { project } = await call(owner.cookie, "/api/projects", "POST", { name: "Secret", visibility: "private", sharedUserIds: [shared.id] });
  const { issue } = await call(owner.cookie, "/api/issues", "POST", { projectId: project.id, body: "# Secret issue", lane: "todo" });
  return { app, dir: entry.dir, request, call, admin, adminId, owner, shared, other, project, issue };
}

test("project access defaults, strict validation, ownership transfer and archived settings", async () => {
  const { call, request, admin, adminId, owner, shared, other, project } = await fixture();
  expect(project).toMatchObject({ visibility: "private", ownerId: owner.id, sharedUserIds: [shared.id] });
  const { project: publicProject } = await call(other.cookie, "/api/projects", "POST", { name: "Public" });
  expect(publicProject).toMatchObject({ visibility: "public", ownerId: other.id, sharedUserIds: [] });
  expect((await request("", `/api/projects/${publicProject.slug}`)).status).toBe(401);
  await call(owner.cookie, `/api/projects/${publicProject.slug}`);
  for (const body of [{ ownerId: adminId }, { visibility: "anonymous" }, { sharedUserIds: [shared.id, shared.id] }, { sharedUserIds: [crypto.randomUUID()] }])
    expect((await request(owner.cookie, "/api/projects", "POST", { name: "Invalid", ...body })).status).toBe(400);
  const path = `/api/projects/${project.slug}/access`;
  expect((await request(shared.cookie, path, "PATCH", { visibility: "public" })).status).toBe(403);
  expect((await request(other.cookie, path, "PATCH", { visibility: "public" })).status).toBe(404);
  for (const body of [{}, { ownerId: null }, { ownerId: crypto.randomUUID() }, { visibility: "invalid" }, { sharedUserIds: [shared.id, shared.id] }, { sharedUserIds: [crypto.randomUUID()] }, { name: "No" }, { visibility: "public", archived: true }]) {
    expect((await request(owner.cookie, path, "PATCH", body)).status).toBe(400);
    expect((await call(owner.cookie, `/api/projects/${project.slug}`)).project).toMatchObject({ visibility: "private", ownerId: owner.id, sharedUserIds: [shared.id] });
  }
  await call(shared.cookie, `/api/projects/${project.slug}`, "PATCH", { archived: true });
  const { project: changed } = await call(owner.cookie, path, "PATCH", { ownerId: other.id, sharedUserIds: [] });
  expect(changed).toMatchObject({ ownerId: other.id, visibility: "private", sharedUserIds: [] });
  expect(changed.archivedAt).not.toBeNull();
  expect((await request(owner.cookie, `/api/projects/${project.slug}`)).status).toBe(404);
  await call(other.cookie, path, "PATCH", { visibility: "public" });
  await call(admin, path, "PATCH", { visibility: "private", ownerId: adminId });
  await call(admin, `/api/projects/${project.slug}`, "PATCH", { archived: false });
});

test("private data is filtered from lists, boards, references and favorites after revocation", async () => {
  const { call, request, admin, owner, shared, other, project, issue } = await fixture();
  const { issue: unlinked } = await call(other.cookie, "/api/issues", "POST", { body: "# Workspace issue" });
  await call(shared.cookie, `/api/me/favorite-projects/${project.id}`, "PUT");
  for (const auth of [owner.cookie, shared.cookie, admin]) {
    await call(auth, `/api/projects/${project.slug}`);
    await call(auth, `/api/issues/${issue.id}`);
    await call(auth, `/api/issues/${issue.id}/history`);
  }
  for (const auth of [other.cookie, shared.cookie]) {
    if (auth === shared.cookie) await call(owner.cookie, `/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [] });
    expect((await call(auth, "/api/projects")).projects.map((p: any) => p.id)).not.toContain(project.id);
    const listing = await call(auth, "/api/issues");
    expect(listing.issues.map((i: any) => i.id)).toEqual([unlinked.id]);
    expect(listing.boards[project.id]).toBeUndefined();
    expect((await call(auth, `/api/issues/references?q=${issue.id}`)).issues.map((i: any) => i.id)).not.toContain(issue.id);
    expect((await call(auth, "/api/me/favorite-projects")).projectIds).not.toContain(project.id);
    for (const method of ["PUT", "DELETE"]) expect((await request(auth, `/api/me/favorite-projects/${project.id}`, method)).status).toBe(404);
  }
  await call(owner.cookie, `/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [shared.id] });
  expect((await call(shared.cookie, "/api/me/favorite-projects")).projectIds).toContain(project.id);
});

test("all direct project, issue, comment and board routes hide inaccessible targets", async () => {
  const { call, request, owner, shared, other, project, issue } = await fixture();
  const { comment } = await call(shared.cookie, `/api/issues/${issue.id}/comments`, "POST", { body: "Shared comment" });
  await call(owner.cookie, `/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [] });
  const p = `/api/projects/${project.slug}`, i = `/api/issues/${issue.id}`, b = `${p}/board/issues`;
  const routes: [string, string, unknown?][] = [
    ["GET", p], ["PATCH", p, { name: "Hidden" }], ["PATCH", p, { archived: true }], ["PATCH", p, { archived: false }],
    ["GET", `${p}/issues`], ["POST", `${p}/issues`, { body: "Hidden" }], ["POST", "/api/issues", { body: "Hidden", projectId: project.id }],
    ["GET", `${p}/board`], ["PATCH", `${p}/board`, { lanes: ["todo"] }], ["PATCH", `${p}/board/lanes/todo`, { index: 1 }],
    ["POST", b, { issueIds: [issue.id], lane: "todo" }], ["PUT", b, { issueIds: [issue.id], lane: "done" }],
    ["POST", `${b}/reorder`, { issueIds: [issue.id], lane: "todo", beforeIssueId: null }],
    ["PATCH", `${b}/${issue.id}`, { lane: "done" }], ["DELETE", `${b}/${issue.id}`],
    ["POST", `${p}/issues/tag`, { issueIds: [issue.id], userIds: [owner.id] }], ["POST", `${p}/issues/labels`, { issueIds: [issue.id], labels: ["bug"] }],
    ["GET", i], ["GET", `${i}/history`], ["PATCH", i, { body: "Hidden" }], ["PATCH", i, { state: "closed" }],
    ["PATCH", i, { projectId: null }], ["POST", `${i}/comments`, { body: "Hidden" }],
    ["PATCH", `/api/comments/${comment.id}`, { body: "Hidden" }], ["DELETE", `/api/comments/${comment.id}`],
  ];
  for (const auth of [other.cookie, shared.cookie]) for (const [method, path, body] of routes)
    expect((await request(auth, path, method, body)).status).toBe(404);
  expect((await call(owner.cookie, i)).issue.body).toBe("# Secret issue");
});

test("readers retain collaboration; moves require both projects; mixed inaccessible bulk writes rollback", async () => {
  const { call, request, owner, shared, other, project, issue } = await fixture();
  await call(shared.cookie, `/api/projects/${project.slug}`, "PATCH", { name: "Collaborative" });
  await call(shared.cookie, `/api/issues/${issue.id}`, "PATCH", { body: "# Collaborated" });
  await call(shared.cookie, `/api/projects/${project.slug}/board/issues/${issue.id}`, "PATCH", { lane: "done" });
  await call(shared.cookie, `/api/projects/${project.slug}`, "PATCH", { archived: true });
  expect((await request(shared.cookie, `/api/issues/${issue.id}`, "PATCH", { body: "No" })).status).toBe(409);
  await call(shared.cookie, `/api/projects/${project.slug}`, "PATCH", { archived: false });
  const { issue: open } = await call(other.cookie, "/api/issues", "POST", { body: "# Open workspace" });
  const before = await call(other.cookie, `/api/issues/${open.id}`);
  const history = await call(other.cookie, `/api/issues/${open.id}/history`);
  for (const [path, fields] of [["/api/issues/labels", { labels: ["rollback"] }], ["/api/issues/tagged-users", { userIds: [owner.id] }]] as const) {
    expect((await request(other.cookie, path, "POST", { issueIds: [open.id, issue.id], ...fields })).status).toBe(404);
    expect(await call(other.cookie, `/api/issues/${open.id}`)).toEqual(before);
    expect(await call(other.cookie, `/api/issues/${open.id}/history`)).toEqual(history);
  }
  expect((await request(other.cookie, `/api/issues/${open.id}`, "PATCH", { projectId: project.id, body: "No" })).status).toBe(404);
  expect(await call(other.cookie, `/api/issues/${open.id}`)).toEqual(before);
  await call(shared.cookie, `/api/issues/${open.id}`, "PATCH", { projectId: project.id });
  expect((await request(other.cookie, `/api/issues/${open.id}`)).status).toBe(404);
  await call(shared.cookie, `/api/issues/${open.id}`, "PATCH", { projectId: null });
  await call(other.cookie, `/api/issues/${open.id}`);
});

test("uploads start private and dynamically follow saved issue/comment/history access", async () => {
  const { app, call, request, admin, owner, shared, other, project, issue } = await fixture();
  const upload = async () => {
    const form = new FormData(); form.append("file", new File(["private attachment"], "secret.txt"));
    const response = await app.request("/api/uploads", { method: "POST", headers: { Cookie: owner.cookie, Origin: "http://localhost:3000" }, body: form });
    expect(response.status).toBe(200); return (await response.json()).attachment.url as string;
  };
  // Hono decodes IDs in paths; encoded references must have identical access.
  const rawUrl = await upload();
  const url = rawUrl.replace(/(\/api\/uploads\/)(.)/, (_, prefix, first) => `${prefix}%${first.charCodeAt(0).toString(16)}`);
  expect((await request(owner.cookie, url)).status).toBe(200);
  expect((await request(admin, url)).status).toBe(200);
  for (const auth of [shared.cookie, other.cookie]) expect((await request(auth, url)).status).toBe(404);
  expect((await request("", url)).status).toBe(401);
  const { project: publicProject } = await call(other.cookie, "/api/projects", "POST", { name: "Outsider public project" });
  const { issue: workspace } = await call(other.cookie, "/api/issues", "POST", { projectId: publicProject.id, body: "# Safe workspace" });
  const { comment: safeComment } = await call(other.cookie, `/api/issues/${workspace.id}/comments`, "POST", { body: "Safe comment" });
  const before = await call(other.cookie, `/api/issues/${workspace.id}/history`);
  const detailBefore = await call(other.cookie, `/api/issues/${workspace.id}`);
  const issuesBefore = await call(other.cookie, `/api/projects/${publicProject.slug}/issues`);
  // Both private drafts and already-saved private attachments must resist URL laundering.
  for (const saved of [false, true]) {
    if (saved) await call(owner.cookie, `/api/issues/${issue.id}`, "PATCH", { body: `# Secret\n\n[file](${url})` });
    for (const [path, method, body] of [
      ["/api/issues", "POST", { projectId: publicProject.id, body: `[stolen](${url})` }],
      [`/api/projects/${publicProject.slug}/issues`, "POST", { body: `[stolen](${url})` }],
      [`/api/issues/${workspace.id}`, "PATCH", { body: `[stolen](${url})` }],
      [`/api/issues/${workspace.id}/comments`, "POST", { body: `[stolen](${url})` }],
      [`/api/comments/${safeComment.id}`, "PATCH", { body: `[stolen](${url})` }],
    ] as const) expect((await request(other.cookie, path, method, body)).status).toBe(404);
    expect(await call(other.cookie, `/api/issues/${workspace.id}`)).toEqual(detailBefore);
    expect(await call(other.cookie, `/api/issues/${workspace.id}/history`)).toEqual(before);
    expect(await call(other.cookie, `/api/projects/${publicProject.slug}/issues`)).toEqual(issuesBefore);
    expect((await request(other.cookie, url)).status).toBe(404);
  }
  expect((await request(shared.cookie, url)).status).toBe(200);
  expect((await request(other.cookie, url)).status).toBe(404);
  await call(owner.cookie, `/api/issues/${issue.id}`, "PATCH", { body: "# No current link" });
  expect((await request(shared.cookie, url)).status).toBe(200); // Saved history still refers to it.
  const commentUrl = await upload();
  const { comment } = await call(owner.cookie, `/api/issues/${issue.id}/comments`, "POST", { body: `[file](${commentUrl})` });
  expect((await request(shared.cookie, commentUrl)).status).toBe(200);
  await call(owner.cookie, `/api/comments/${comment.id}`, "DELETE");
  expect((await request(shared.cookie, commentUrl)).status).toBe(200);
  await call(owner.cookie, `/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [] });
  for (const path of [url, commentUrl]) expect((await request(shared.cookie, path)).status).toBe(404);
  await call(owner.cookie, `/api/issues/${issue.id}`, "PATCH", { projectId: null });
  for (const path of [url, commentUrl]) expect((await request(other.cookie, path)).status).toBe(200);
  await call(owner.cookie, `/api/issues/${issue.id}`, "PATCH", { projectId: project.id });
  for (const path of [url, commentUrl]) expect((await request(other.cookie, path)).status).toBe(404);
  // Upload authorship is not a permanent bypass once a file has saved references.
  await call(owner.cookie, `/api/projects/${project.slug}/access`, "PATCH", { ownerId: shared.id, sharedUserIds: [] });
  for (const path of [url, commentUrl]) expect((await request(owner.cookie, path)).status).toBe(404);
});

test("legacy referenced uploads inherit access while legacy orphan uploads are administrator-only", async () => {
  const entry = directory(), path = join(entry.dir, "app.sqlite");
  const old = openDatabase(path, 13);
  const password = "long-password-123", hash = Bun.password.hashSync(password);
  for (const role of ["admin", "member"]) old.query("INSERT INTO users (id,name,email,role,createdAt,password) VALUES (?,?,?,?,?,?)").run(role, role, `${role}@example.com`, role, "old", hash);
  old.exec("INSERT INTO projects (id,slug,name,description,createdAt) VALUES ('legacy','legacy','Legacy','','old');");
  const linked = crypto.randomUUID(), orphan = crypto.randomUUID();
  mkdirSync(join(entry.dir, "uploads"), { recursive: true });
  for (const id of [linked, orphan]) {
    old.query("INSERT INTO attachments (id,name,mime,size) VALUES (?,'legacy.txt','application/octet-stream',6)").run(id);
    writeFileSync(join(entry.dir, "uploads", id), "legacy");
  }
  old.query("INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (1,'legacy','Legacy',?,'backlog','none','[]','admin','old','old')").run(`[file](/api/uploads/%${linked.charCodeAt(0).toString(16)}${linked.slice(1)}/legacy.txt)`);
  old.close();
  const app = entry.app = createApp({ dataDir: entry.dir });
  const cookies: Record<string, string> = {};
  for (const role of ["admin", "member"]) {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ email: `${role}@example.com`, password }) });
    expect(login.status).toBe(200); cookies[role] = login.headers.get("set-cookie")!.split(";")[0]!;
  }
  const download = (role: string, id: string) => app.request(`/api/uploads/${id}/legacy.txt`, { headers: { Cookie: cookies[role]! } });
  expect((await download("member", linked)).status).toBe(200);
  expect((await download("member", orphan)).status).toBe(404);
  expect((await download("admin", orphan)).status).toBe(200);
  const change = await app.request("/api/projects/legacy/access", { method: "PATCH", headers: { Origin: "http://localhost:3000", Cookie: cookies.admin!, "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "private" }) });
  expect(change.status).toBe(200);
  expect((await download("member", linked)).status).toBe(404);
  expect((await download("admin", linked)).status).toBe(200);
});

test("v14 upgrades existing projects to public with deterministic oldest administrator ownership", () => {
  for (const users of [true, false]) {
    const { dir } = directory(); const path = join(dir, "app.sqlite");
    const old = openDatabase(path, 13);
    expect(old.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 13 });
    if (users) old.exec(`INSERT INTO users (id,name,email,role,createdAt) VALUES
      ('member','Member','member@example.com','member','2000'),
      ('z-admin','Z','z@example.com','admin','2001'),
      ('a-admin','A','a@example.com','admin','2001'),
      ('new-admin','New','new@example.com','admin','2002');`);
    old.exec("INSERT INTO projects (id,slug,name,description,createdAt) VALUES ('legacy','legacy','Legacy','Preserve me','old');");
    old.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDatabase(path);
      try {
        expect(db.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 14 });
        expect(db.query("SELECT name,description,createdAt,visibility,ownerId FROM projects WHERE id='legacy'").get()).toEqual({ name: "Legacy", description: "Preserve me", createdAt: "old", visibility: "public", ownerId: users ? "a-admin" : null });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    }
  }
});
