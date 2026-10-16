import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const x of owned.splice(0)) { x.app?.close(); rmSync(x.dir, { recursive: true, force: true }); } });
async function fixture() {
  const x = { dir: mkdtempSync(join(tmpdir(), "board-sub-issue-progress-")), app: undefined as ReturnType<typeof createApp> | undefined };
  owned.push(x);
  const app = x.app = createApp({ dataDir: x.dir });
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
  const { project } = await call(admin, "/api/projects", "POST", { name: "Board" });
  const path = `/api/projects/${project.slug}`;
  const endpoint = `${path}/board/sub-issue-progress`;
  const create = async (extra = {}, auth = admin) => (await call(auth, "/api/issues", "POST", { body: "Issue", ...extra })).issue;
  const link = (parent: string, child: string) => call(admin, `/api/issues/${parent}/sub-issues`, "POST", { issueId: child });
  const progress = (auth = admin) => call(auth, endpoint);
  return { app, call, request, admin, member, user, project, path, endpoint, create, link, progress };
}

test("board aggregate tracks direct children, lifecycle, membership and links, not lanes or descendants", async () => {
  const { call, admin, project, path, create, link, progress } = await fixture();
  const parent = await create({ projectId: project.id, lane: "todo" });
  await create({ projectId: project.id, lane: "todo" }); // Leaf: no placeholder.
  const offBoardParent = await create({ projectId: project.id });
  await create({ parentId: offBoardParent.id });
  expect(await progress()).toEqual({ progress: {} });
  const child = await create({ projectId: project.id, lane: "done", parentId: parent.id });
  const offBoardChild = await create({ parentId: parent.id });
  const grandchild = await create({ parentId: offBoardChild.id });
  await call(admin, `/api/issues/${grandchild.id}`, "PATCH", { state: "closed" });
  expect(await progress()).toEqual({ progress: { [parent.id]: { total: 2, closed: 0 } } });
  await call(admin, `/api/issues/${child.id}`, "PATCH", { state: "closed" });
  expect(await progress()).toEqual({ progress: { [parent.id]: { total: 2, closed: 1 } } });
  await call(admin, `/api/issues/${child.id}`, "PATCH", { state: "open" });
  await call(admin, `/api/issues/${parent.id}/sub-issues/${offBoardChild.id}`, "DELETE");
  expect(await progress()).toEqual({ progress: { [parent.id]: { total: 1, closed: 0 } } });
  await link(parent.id, offBoardChild.id);
  await call(admin, `${path}/board`, "PATCH", { lanes: ["done"] });
  expect(await progress()).toEqual({ progress: { [parent.id]: { total: 2, closed: 0 } } });
  await call(admin, `${path}/board/issues/${parent.id}`, "DELETE");
  expect(await progress()).toEqual({ progress: {} });
});

test("cross-project counts follow privacy, sharing revocation, moves and archived boards", async () => {
  const { call, request, admin, member, user, project, path, endpoint, create, progress } = await fixture();
  const { project: privateProject } = await call(admin, "/api/projects", "POST", { name: "Private", visibility: "private", sharedUserIds: [user.id] });
  const privatePath = `/api/projects/${privateProject.slug}`;
  const parent = await create({ projectId: project.id, lane: "todo" });
  const child = await create({ projectId: privateProject.id, parentId: parent.id });
  const expected = { progress: { [parent.id]: { total: 1, closed: 0 } } };
  expect(await progress(member)).toEqual(expected);
  await call(admin, `${privatePath}/access`, "PATCH", { sharedUserIds: [] });
  expect(await progress(member)).toEqual({ progress: {} });
  expect(await progress()).toEqual(expected);
  expect((await request(member, `${privatePath}/board/sub-issue-progress`)).status).toBe(404);
  await call(admin, `/api/issues/${child.id}`, "PATCH", { projectId: null });
  expect(await progress(member)).toEqual(expected);
  await call(admin, `/api/issues/${child.id}`, "PATCH", { projectId: privateProject.id });
  expect(await progress(member)).toEqual({ progress: {} });
  await call(admin, `${privatePath}/access`, "PATCH", { sharedUserIds: [user.id] });
  await call(admin, privatePath, "PATCH", { archived: true });
  await call(admin, path, "PATCH", { archived: true });
  expect(await progress(member)).toEqual(expected);
  await call(admin, `${path}/access`, "PATCH", { visibility: "private" });
  expect((await request(member, endpoint)).status).toBe(404);
  expect(await progress()).toEqual(expected);
  await call(admin, path, "PATCH", { archived: false });
  await call(admin, `/api/issues/${parent.id}`, "PATCH", { projectId: null });
  expect(await progress()).toEqual({ progress: {} });
});

test("draft endpoints are excluded even for their author and stale relationships", async () => {
  const { app, project, create, progress, member } = await fixture();
  const parent = await create({ projectId: project.id, lane: "todo" });
  const draft = await create({ state: "draft" });
  // Public writes reject draft links; test defensive read filtering of legacy/stale data.
  app.db.query("INSERT INTO issue_relationships (childId,parentId) VALUES (?,?)").run(draft.id, parent.id);
  expect(await progress()).toEqual({ progress: {} });
  expect(await progress(member)).toEqual({ progress: {} });
  app.db.query("UPDATE issues SET isDraft=0 WHERE id=?").run(draft.id);
  app.db.query("UPDATE issues SET isDraft=1 WHERE id=?").run(parent.id);
  expect(await progress()).toEqual({ progress: {} });
  expect(await progress(member)).toEqual({ progress: {} });
});

test("authenticated read-only bearer supported without exposing credential data; revoked/invalid keys rejected", async () => {
  const { app, call, request, admin, member, project, endpoint, create } = await fixture();
  const parent = await create({ projectId: project.id, lane: "todo" });
  await create({ parentId: parent.id });
  const key = await call(member, "/api/me/api-keys", "POST", { name: "reader", scopes: ["read"], expiresInDays: 1 });
  const result = await app.request(endpoint, { headers: { Authorization: `Bearer ${key.token}` } });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(await result.json()).toEqual({ progress: { [parent.id]: { total: 1, closed: 0 } } });
  expect((await request("", endpoint)).status).toBe(401);
  expect((await request(member, "/api/projects/missing/board/sub-issue-progress")).status).toBe(404);
  expect((await app.request(endpoint, { headers: { Cookie: admin, Authorization: "Bearer invalid" } })).status).toBe(401);
  await call(member, `/api/me/api-keys/${key.key.id}`, "DELETE");
  expect((await request(`Bearer ${key.token}`, endpoint)).status).toBe(401);
});
