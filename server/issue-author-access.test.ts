import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { WorkspacePermissions } from "../shared/types";

const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(async () => {
  for (const { dir, app } of owned.splice(0)) {
    await app.plugins.close(); app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "issue-author-access-"));
  const app = createApp({ dataDir: dir }); owned.push({ dir, app });
  const request = (cookie: string, path: string, method = "GET", body?: unknown, token?: string) => app.request(path, {
    method, headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json", "X-Workspace-Slug": "acl", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (cookie: string, path: string, method = "GET", body?: unknown) => {
    const response = await request(cookie, path, method, body);
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const password = "author-access-password";
  const setup = await request("", "/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  await call(admin, "/api/workspaces", "POST", { name: "ACL", slug: "acl", visibility: "public" });
  const { user } = await call(admin, "/api/admin/users", "POST", { name: "Author", email: "author@example.com", password });
  const login = await request("", "/api/auth/login", "POST", { email: user.email, password });
  const author = login.headers.get("set-cookie")!.split(";")[0]!;
  await call(admin, "/api/workspaces/acl/invitations", "POST", { email: user.email, defaultAccess: "full" });
  await call(author, "/api/workspaces");
  const setAccess = (defaultAccess: WorkspacePermissions, projectAccess: { projectId: string; access: WorkspacePermissions }[] = []) =>
    call(admin, `/api/workspaces/acl/members/${user.id}`, "PATCH", { defaultAccess, projectAccess });
  const project = async (name: string) => (await call(admin, "/api/projects", "POST", { name })).project;
  const issue = async (cookie: string, projectId: string | null, extra = {}) =>
    (await call(cookie, "/api/issues", "POST", { body: "Issue", projectId, ...extra })).issue;
  return { app, admin, author, request, call, setAccess, project, issue };
}

test("create-only filters issue lists, references, board cards, counts and relationship progress", async () => {
  const f = await fixture(), p = await f.project("Visible metadata");
  const own = await f.issue(f.author, p.id, { lane: "todo" });
  const other = await f.issue(f.admin, p.id, { lane: "todo" });
  f.app.db.query("UPDATE issues SET updatedAt='2099-01-01T00:00:00Z' WHERE id=?").run(other.id);
  await f.call(f.admin, `/api/issues/${own.id}/sub-issues`, "POST", { issueId: other.id });
  await f.setAccess("create-issue");
  expect((await f.call(f.author, "/api/issues")).issues.map((i: any) => i.id)).toEqual([own.id]);
  expect((await f.call(f.author, "/api/issues/references?q=Issue")).issues.map((i: any) => i.id)).toEqual([own.id]);
  const listed = (await f.call(f.author, "/api/projects")).projects[0];
  expect(listed.issueCount).toBe(1); expect(listed.openCount).toBe(1);
  expect(listed.lastIssueUpdatedAt).not.toBe('2099-01-01T00:00:00Z');
  const ownCards = [{ issueId: own.id, lane: 'todo' }];
  expect((await f.call(f.author, '/api/issues')).boards[p.id].cards).toEqual(ownCards);
  for (const method of ['POST', 'PUT']) {
    const created = (await f.call(f.author, '/api/issues', 'POST', { body: 'New own issue', projectId: p.id, lane: 'todo' }));
    expect(created.board.cards.some((card: any) => card.issueId === other.id)).toBe(false);
    const moved = await f.request(f.author, `/api/projects/${p.slug}/board/issues`, method, { issueIds: [own.id], lane: 'done' });
    // POST is an add operation: the existing member correctly conflicts.
    if (method === 'POST') expect(moved.status).toBe(409);
    else {
      expect(moved.status).toBe(200);
      expect((await moved.json()).board.cards.some((card: any) => card.issueId === other.id)).toBe(false);
    }
  }
  const reordered = await f.call(f.author, `/api/projects/${p.slug}/board/issues/reorder`, 'POST', { issueIds: [own.id], lane: 'todo', beforeIssueId: null });
  expect(reordered.board.cards.some((card: any) => card.issueId === other.id)).toBe(false);
  for (const method of ['PATCH', 'DELETE']) expect((await f.request(f.author, `/api/projects/${p.slug}/board/issues/${other.id}`, method, method === 'PATCH' ? { lane: 'done' } : undefined)).status).toBe(404);
  const board = (await f.call(f.author, `/api/projects/${p.slug}/board`)).board;
  expect(JSON.stringify(board)).toContain(`"${own.id}"`);
  expect(JSON.stringify(board)).not.toContain(`"${other.id}"`);
  expect((await f.call(f.author, `/api/issues/${own.id}/relationships`)).subIssues).toEqual([]);
  expect((await f.call(f.author, `/api/projects/${p.slug}/board/sub-issue-progress`)).progress).toEqual({});
  for (const suffix of ["", "/history", "/relationships", "/external-links"])
    expect((await f.request(f.author, `/api/issues/${other.id}${suffix}`)).status).toBe(404);
  await f.setAccess("read+create-issue");
  expect((await f.call(f.author, "/api/issues")).issues).toHaveLength(4);
  expect((await f.call(f.author, `/api/issues/${own.id}/relationships`)).subIssues).toHaveLength(1);
  expect((await f.request(f.author, `/api/issues/${other.id}`, "PATCH", { body: "Forbidden" })).status).toBe(403);
  await f.issue(f.author, p.id);
});

test("authors retain issue mutations at read access but cannot create, move into read-only projects or edit others", async () => {
  const f = await fixture(), p = await f.project("Source"), q = await f.project("Target");
  const own = await f.issue(f.author, p.id, { lane: "todo" });
  const child = await f.issue(f.author, p.id);
  const other = await f.issue(f.admin, p.id);
  await f.setAccess("read");
  await f.call(f.author, `/api/issues/${own.id}`, "PATCH", { body: "Author edited" });
  await f.call(f.author, `/api/issues/${own.id}/comments`, "POST", { body: "Author comment" });
  await f.call(f.author, "/api/issues/labels", "POST", { issueIds: [own.id], labels: ["bug"] });
  await f.call(f.author, `/api/projects/${p.slug}/board/issues/${own.id}`, "PATCH", { lane: "done" });
  await f.call(f.author, `/api/issues/${own.id}/sub-issues`, "POST", { issueId: child.id });
  expect((await f.request(f.author, `/api/issues/${own.id}/sub-issues`, "POST", { issueId: other.id })).status).toBe(403);
  expect((await f.request(f.author, "/api/issues", "POST", { body: "No creation", projectId: p.id })).status).toBe(403);
  expect((await f.request(f.author, `/api/issues/${own.id}`, "PATCH", { projectId: q.id })).status).toBe(403);
  await f.setAccess("read", [{ projectId: q.id, access: "create-issue" }]);
  await f.call(f.author, `/api/issues/${own.id}`, "PATCH", { projectId: q.id });
  await f.setAccess("none");
  expect((await f.request(f.author, `/api/issues/${own.id}`)).status).toBe(404);
  expect((await f.request(f.author, `/api/issues/${own.id}`, "PATCH", { body: "Revoked" })).status).toBe(404);
});

test("draft ownership never bypasses current access and archives block author writes", async () => {
  const f = await fixture(), p = await f.project("Drafts");
  const own = await f.issue(f.author, p.id, { state: "draft" });
  expect((await f.request(f.admin, `/api/issues/${own.id}`)).status).toBe(404);
  await f.setAccess("none");
  expect((await f.request(f.author, `/api/issues/${own.id}`)).status).toBe(404);
  expect((await f.request(f.author, `/api/issues/${own.id}`, "PATCH", { state: "open" })).status).toBe(404);
  await f.setAccess("read");
  await f.call(f.author, `/api/issues/${own.id}`, "PATCH", { body: "Editable draft" });
  await f.call(f.admin, `/api/projects/${p.slug}`, "PATCH", { archived: true });
  expect((await f.request(f.author, `/api/issues/${own.id}`)).status).toBe(200);
  expect((await f.request(f.author, `/api/issues/${own.id}`, "PATCH", { body: "Archived" })).status).toBe(409);
});

test("new permission scopes replace defaults and apply to future projects without granting management", async () => {
  const f = await fixture(), selected = await f.project("Selected"), other = await f.project("Other");
  await f.setAccess("none", [{ projectId: selected.id, access: "create-issue" }]);
  expect((await f.call(f.author, "/api/projects")).projects.map((p: any) => p.id)).toEqual([selected.id]);
  const own = await f.issue(f.author, selected.id);
  expect((await f.request(f.author, "/api/issues", "POST", { body: "No unlinked" })).status).toBe(404);
  expect((await f.request(f.author, "/api/issues", "POST", { body: "No other", projectId: other.id })).status).toBe(404);
  await f.setAccess("read+create-issue", [{ projectId: selected.id, access: "create-issue" }, { projectId: other.id, access: "read" }]);
  const hidden = await f.issue(f.admin, selected.id), visible = await f.issue(f.admin, other.id);
  const future = await f.project("Future"), futureIssue = await f.issue(f.admin, future.id);
  await f.issue(f.author, future.id);
  const ids = (await f.call(f.author, "/api/issues")).issues.map((i: any) => i.id);
  expect(ids).toContain(own.id); expect(ids).not.toContain(hidden.id);
  expect(ids).toContain(visible.id); expect(ids).toContain(futureIssue.id);
  expect((await f.request(f.author, "/api/issues", "POST", { body: "Read override", projectId: other.id })).status).toBe(403);
  for (const [path, body] of [
    ["/api/projects", { name: "No project creation" }],
    [`/api/projects/${selected.slug}`, { name: "No project rename" }],
    [`/api/projects/${selected.slug}`, { archived: true }],
    [`/api/projects/${selected.slug}/board`, { lanes: ["todo"] }],
  ] as const) expect((await f.request(f.author, path, path === "/api/projects" ? "POST" : "PATCH", body)).status).toBe(403);
});

test("attachments, comments, duplicate targets and mixed mutations cannot leak or edit other authors' issues", async () => {
  const f = await fixture(), p = await f.project("Private reports");
  const file = new FormData(); file.set("file", new File(["private attachment content"], "private.txt"));
  const uploaded = await f.app.request("/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000", Cookie: f.admin, "X-Workspace-Slug": "acl" }, body: file });
  expect(uploaded.status).toBe(200);
  const url = (await uploaded.json()).attachment.url;
  const other = await f.issue(f.admin, p.id, { body: `Other issue [file](${url})`, lane: "todo" });
  const own = await f.issue(f.author, p.id, { lane: "todo" });
  await f.setAccess("create-issue");
  expect((await f.request(f.author, url)).status).toBe(404);
  expect((await f.request(f.author, `/api/issues/${own.id}`, "PATCH", { body: `Launder [file](${url})` })).status).toBe(404);
  expect((await f.request(f.author, `/api/issues/${own.id}/close`, "POST", { reason: "duplicate", duplicateOfId: other.id })).status).toBe(404);
  for (const permissions of ["create-issue", "read+create-issue"] as const) {
    await f.setAccess(permissions);
    expect((await f.request(f.author, `/api/issues/${other.id}/comments`, "POST", { body: "No comment" })).status).toBe(permissions === "create-issue" ? 404 : 403);
    const before = f.app.db.query("SELECT * FROM issues ORDER BY id").all();
    expect((await f.request(f.author, "/api/issues/labels", "POST", { issueIds: [own.id, other.id], labels: ["forbidden"] })).ok).toBe(false);
    expect(f.app.db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(before);
  }
  expect((await f.request(f.author, url)).status).toBe(200);
  const comment = (await f.call(f.author, `/api/issues/${own.id}/comments`, "POST", { body: "Own comment" })).comment;
  await f.call(f.author, `/api/comments/${comment.id}`, "PATCH", { body: "Edited own comment" });
  await f.call(f.author, `/api/comments/${comment.id}`, "DELETE");
  await f.setAccess("none");
  expect((await f.request(f.author, url)).status).toBe(404);
});

test("uploads and bearer scopes enforce the same current author permissions", async () => {
  const f = await fixture(), p = await f.project("Files");
  const own = await f.issue(f.author, p.id);
  const readKey = (await f.call(f.author, "/api/me/api-keys", "POST", { name: "Read", scopes: ["read"], expiresInDays: 1 })).token;
  const writeKey = (await f.call(f.author, "/api/me/api-keys", "POST", { name: "Write", scopes: ["read", "write"], expiresInDays: 1 })).token;
  await f.setAccess("read");
  const upload = async () => {
    const body = new FormData(); body.set("file", new File(["attachment"], "test.txt"));
    return f.app.request("/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000", Cookie: f.author, "X-Workspace-Slug": "acl" }, body });
  };
  expect((await upload()).status).toBe(200);
  expect((await f.request("", `/api/issues/${own.id}`, "PATCH", { body: "Read token" }, readKey)).status).toBe(403);
  expect((await f.request("", `/api/issues/${own.id}`, "PATCH", { body: "Write token" }, writeKey)).status).toBe(200);
  expect((await f.request("", "/api/issues", "POST", { body: "Cannot create" }, writeKey)).status).toBe(403);
  await f.setAccess("none");
  expect((await upload()).status).toBe(403);
  expect((await f.request("", `/api/issues/${own.id}`, "GET", undefined, readKey)).status).toBe(404);
  expect((await f.request("", `/api/issues/${own.id}`, "PATCH", { body: "Revoked token" }, writeKey)).status).toBe(404);
});
