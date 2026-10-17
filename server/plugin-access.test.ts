import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { PluginDefinition } from "./plugins";
import type { PluginEvent } from "../shared/plugins";
import type { WorkspacePermissions } from "../shared/types";

const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(async () => {
  for (const { dir, app } of owned.splice(0)) {
    await app.plugins.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const origin = "http://localhost:3000";
async function fixture() {
  const events: PluginEvent[] = [];
  let throwHook = false;
  const plugin: PluginDefinition = {
    id: "fixture", name: "Fixture", description: "Access test plugin", fields: [], defaults: {},
    hook(event, context) {
      events.push(event);
      if (throwHook) throw new Error("Isolated hook failure");
      context.putLink(event.issueId, { externalId: "session", title: "Implementation", url: "https://example.com/session", status: "Running", tone: "info" });
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "threadline-plugin-access-"));
  const app = createApp({ dataDir: dir, pluginDefinitions: [plugin] });
  owned.push({ dir, app });
  const request = (path: string, method = "GET", body?: unknown, cookie = "", extra: Record<string, string> = {}) => app.request(path, {
    method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await request("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  const admin = (await setup.json()).user;
  const adminCookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const web = (path: string, method = "GET", body?: unknown, cookie = adminCookie) => request(path, method, body, cookie);
  const member = async (name: string) => {
    const { user } = await (await web("/api/admin/users", "POST", { name, email: `${name}@example.com`, password: "long-password-123" })).json();
    const login = await request("/api/auth/login", "POST", { email: user.email, password: "long-password-123" });
    return { user, cookie: login.headers.get("set-cookie")!.split(";")[0]! };
  };
  expect((await web("/api/admin/plugins/fixture", "PUT", { enabled: true, values: {} })).status).toBe(200);
  return { app, web, request, member, admin, adminCookie, events, failHooks: () => { throwHook = true; } };
}

test("plugin link reads inherit draft and project access on direct, list and detail routes", async () => {
  const { web, request, member } = await fixture();
  const owner = await member("owner"), other = await member("other");
  const { project } = await (await web("/api/projects", "POST", { name: "Private", visibility: "private" }, owner.cookie)).json();
  const create = async (body: string, state = "open", projectId: string | null = null) =>
    (await (await web("/api/issues", "POST", { body, state, projectId }, owner.cookie)).json()).issue;
  const unlinked = await create("Public unlinked");
  const privateIssue = await create("Private project", "open", project.id);
  const draft = await create("Creator only draft", "draft");
  const linkPath = (id: string) => `/api/issues/${id}/external-links`;
  expect((await request(linkPath(unlinked.id))).status).toBe(401);
  for (const item of [unlinked, privateIssue, draft]) {
    const response = await web(linkPath(item.id), "GET", undefined, owner.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).links).toHaveLength(1);
  }
  expect((await web(linkPath(unlinked.id), "GET", undefined, other.cookie)).status).toBe(200);
  expect((await web(linkPath(privateIssue.id), "GET", undefined, other.cookie)).status).toBe(404);
  for (const cookie of [other.cookie, undefined]) {
    expect((await web(linkPath(draft.id), "GET", undefined, cookie)).status).toBe(404);
    expect((await web(`/api/issues/${draft.id}`, "GET", undefined, cookie)).status).toBe(404);
  }
  const listed = await (await web("/api/issues", "GET", undefined, other.cookie)).json();
  expect(listed.issues.map((i: { id: string }) => i.id)).toEqual([unlinked.id]);
  expect(listed.issues[0].externalLinks).toHaveLength(1);
  expect((await web(linkPath("01"))).status).toBe(404);
  // Link visibility changes immediately with normal project sharing.
  await web(`/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [other.user.id] }, owner.cookie);
  expect((await web(linkPath(privateIssue.id), "GET", undefined, other.cookie)).status).toBe(200);
  await web(`/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [] }, owner.cookie);
  expect((await web(linkPath(privateIssue.id), "GET", undefined, other.cookie)).status).toBe(404);
  await web("/api/admin/plugins/fixture", "PUT", { enabled: false, values: {} });
  expect((await (await web(linkPath(unlinked.id))).json()).links).toEqual([]);
});

test("plugin links and hooks follow current issue-level access for every permission level", async () => {
  const { app, web, member, events } = await fixture();
  const author = await member("author");
  const { project } = await (await web("/api/projects", "POST", { name: "ACL matrix" })).json();
  const levels: WorkspacePermissions[] = ["none", "read", "create-issue", "read+create-issue", "full"];
  const setAccess = (level: WorkspacePermissions) => app.db.query(
    "UPDATE workspace_members SET defaultAccess=?,legacyAccess=0 WHERE workspaceId='default' AND userId=?",
  ).run(level, author.user.id);
  for (const projectId of [null, project.id]) {
    setAccess("full");
    const { issue: own } = await (await web("/api/issues", "POST", { body: "Own issue", projectId }, author.cookie)).json();
    const { issue: other } = await (await web("/api/issues", "POST", { body: "Other issue", projectId })).json();
    for (const level of levels) {
      setAccess(level);
      for (const [issue, isOwn] of [[own, true], [other, false]] as const) {
        const readable = level !== "none" && (isOwn || level !== "create-issue");
        const writable = readable && (isOwn || level === "full");
        for (const suffix of ["", "/external-links"]) {
          const response = await web(`/api/issues/${issue.id}${suffix}`, "GET", undefined, author.cookie);
          expect(response.status).toBe(readable ? 200 : 404);
          if (readable) {
            const data = await response.json();
            expect(suffix ? data.links : data.issue.externalLinks).toHaveLength(1);
          }
        }
        events.length = 0;
        const response = await web(`/api/issues/${issue.id}`, "PATCH", { body: `${level}: ${isOwn}` }, author.cookie);
        expect(response.status).toBe(writable ? 200 : readable ? 403 : 404);
        expect(events.map((event) => event.type)).toEqual(writable ? ["issue.updated"] : []);
      }
      const listed = await (await web("/api/issues", "GET", undefined, author.cookie)).json();
      const ids = listed.issues.map((issue: { id: string }) => issue.id);
      expect(ids.includes(own.id)).toBe(level !== "none");
      expect(ids.includes(other.id)).toBe(level !== "none" && level !== "create-issue");
    }
  }
});

test("plugin links cannot bypass revoked draft/project access and archived writes emit no hooks", async () => {
  const { app, web, member, events } = await fixture();
  const author = await member("draft-author");
  const { project } = await (await web("/api/projects", "POST", { name: "Revocable" })).json();
  const { issue: draft } = await (await web("/api/issues", "POST", { body: "Private draft", state: "draft", projectId: project.id }, author.cookie)).json();
  const { issue } = await (await web("/api/issues", "POST", { body: "Published", projectId: project.id }, author.cookie)).json();
  const setOverride = (level: WorkspacePermissions) => {
    app.db.query("UPDATE workspace_members SET defaultAccess='none',legacyAccess=0 WHERE workspaceId='default' AND userId=?").run(author.user.id);
    app.db.query("DELETE FROM workspace_project_access WHERE workspaceId='default' AND userId=?").run(author.user.id);
    if (level !== "none") app.db.query(
      "INSERT INTO workspace_project_access(workspaceId,userId,projectId,access) VALUES ('default',?,?,?)",
    ).run(author.user.id, project.id, level);
  };
  setOverride("none");
  for (const item of [draft, issue]) {
    expect((await web(`/api/issues/${item.id}/external-links`, "GET", undefined, author.cookie)).status).toBe(404);
    events.length = 0;
    expect((await web(`/api/issues/${item.id}`, "PATCH", { body: "Denied" }, author.cookie)).status).toBe(404);
    expect(events).toEqual([]);
  }
  setOverride("read");
  for (const item of [draft, issue]) {
    expect((await web(`/api/issues/${item.id}/external-links`, "GET", undefined, author.cookie)).status).toBe(200);
    expect((await web(`/api/issues/${item.id}`, "PATCH", { body: "Author can edit at read access" }, author.cookie)).status).toBe(200);
  }
  expect((await web(`/api/projects/${project.slug}`, "PATCH", { archived: true })).status).toBe(200);
  for (const item of [draft, issue]) {
    expect((await web(`/api/issues/${item.id}/external-links`, "GET", undefined, author.cookie)).status).toBe(200);
    events.length = 0;
    expect((await web(`/api/issues/${item.id}`, "PATCH", { body: "Archived write denied" }, author.cookie)).status).toBe(409);
    expect(events).toEqual([]);
  }
});

test("plugin settings require admin browser auth and CSRF; bearer keys can read authorized issue links only", async () => {
  const { web, request, member, adminCookie } = await fixture();
  const other = await member("member");
  expect((await web("/api/admin/plugins", "GET", undefined, other.cookie)).status).toBe(403);
  expect((await web("/api/admin/plugins/fixture", "PUT", { enabled: false, values: {} }, other.cookie)).status).toBe(403);
  expect((await request("/api/admin/plugins/fixture", "PUT", { enabled: false, values: {} }, adminCookie, { Origin: "https://evil.example" })).status).toBe(403);
  const { token } = await (await web("/api/me/api-keys", "POST", { name: "Read", scopes: ["read"], expiresInDays: 1 })).json();
  const headers = { Authorization: `Bearer ${token}` };
  for (const path of ["/api/admin/plugins", "/api/plugins"])
    expect((await request(path, "GET", undefined, "", headers)).status).toBe(403);
  const { issue } = await (await web("/api/issues", "POST", { body: "Read by key" })).json();
  const response = await request(`/api/issues/${issue.id}/external-links`, "GET", undefined, "", headers);
  expect(response.status).toBe(200);
  expect((await response.json()).links).toHaveLength(1);
  expect((await web("/api/admin/plugins/unknown", "PUT", { enabled: true, values: {} })).status).toBe(400);
});

test("committed mutations emit the right hooks; no-op and failed mutations emit none; hook failures do not fail writes", async () => {
  const { app, web, events, failHooks, admin } = await fixture();
  const { project } = await (await web("/api/projects", "POST", { name: "Hooks" })).json();
  const { issue } = await (await web("/api/issues", "POST", { body: "Initial", projectId: project.id, lane: "todo" })).json();
  expect(events.map(e => e.type)).toEqual(["issue.created", "card.moved"]);
  expect(app.db.query("SELECT body FROM issues WHERE id=?").get(issue.id)).toEqual({ body: "Initial" });
  events.length = 0;
  expect((await web(`/api/issues/${issue.id}`, "PATCH", { body: "Changed", state: "closed" })).status).toBe(200);
  expect(events.map(e => e.type)).toEqual(["issue.updated", "issue.closed"]);
  events.length = 0;
  await web(`/api/issues/${issue.id}`, "PATCH", { state: "closed" });
  expect(events).toEqual([]);
  await web(`/api/issues/${issue.id}`, "PATCH", { state: "open" });
  expect(events.map(e => e.type)).toEqual(["issue.updated", "issue.reopened"]);
  events.length = 0;
  await web(`/api/projects/${project.slug}/board/issues/${issue.id}`, "PATCH", { lane: "done" });
  expect(events.map(e => e.type)).toEqual(["card.moved"]);
  events.length = 0;
  await web(`/api/projects/${project.slug}/board/issues/${issue.id}`, "PATCH", { lane: "unknown" });
  await web("/api/issues/labels", "POST", { issueIds: [issue.id, "999999"], labels: ["bug"] });
  expect(events).toEqual([]);
  expect(app.db.query("SELECT body FROM issues WHERE id=?").get(issue.id)).toEqual({ body: "Changed" });
  const response = await web(`/api/issues/${issue.id}/comments`, "POST", { body: "Comment" });
  expect(response.status).toBe(200);
  const { comment } = await response.json();
  expect(events).toEqual([{ type: "comment.created", issueId: issue.id, actorId: admin.id, commentId: comment.id }]);
  failHooks();
  expect((await web(`/api/issues/${issue.id}`, "PATCH", { body: "Committed despite hook failure" })).status).toBe(200);
  expect((await (await web(`/api/issues/${issue.id}`)).json()).issue.body).toBe("Committed despite hook failure");
});
