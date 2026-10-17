import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { defaultIssueFilters, emptyIssueFilters } from "../shared/issue-filters";
import { openDatabase } from "./db";
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const e of owned.splice(0)) { e.app.close(); rmSync(e.dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "personal-boards-"));
  const e = { dir, app: createApp({ dataDir: dir }) }; owned.push(e);
  const request = (cookie: string, path: string, method = "GET", body?: unknown, workspace = "default", token?: string) => e.app.request(path, {
    method, headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json", "X-Workspace-Slug": workspace, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (...args: Parameters<typeof request>) => { const r = await request(...args); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); };
  const password = "personal-board-password";
  const setup = await request("", "/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  const admin = setup.headers.get("set-cookie")!.split(";")[0]!;
  const adminId = (await setup.json()).user.id;
  const user = (await call(admin, "/api/admin/users", "POST", { name: "Reader", email: "reader@example.com", password })).user;
  const login = await request("", "/api/auth/login", "POST", { email: user.email, password });
  const reader = login.headers.get("set-cookie")!.split(";")[0]!;
  const project = (await call(admin, "/api/projects", "POST", { name: "Project" })).project;
  const issue = (await call(admin, "/api/issues", "POST", { body: "# Issue", projectId: project.id })).issue;
  return { e, request, call, admin, adminId, user, reader, project, issue };
}

test("personal CRUD, defaults/empty filters, ordering, optimistic concurrency and persistence are private", async () => {
  const f = await fixture();
  const board = (await f.call(f.reader, "/api/me/boards", "POST", { name: " Mine " })).board;
  expect(board).toMatchObject({ name: "Mine", userId: f.user.id, workspaceId: "default", revision: 1, filters: defaultIssueFilters, cards: [] });
  const path = `/api/me/boards/${board.id}`;
  const lane = { value: `custom_${crypto.randomUUID()}`, label: "Review" };
  const updated = (await f.call(f.reader, path, "PATCH", { revision: 1, filters: emptyIssueFilters, search: "hello", customLanes: [lane], lanes: [lane.value, "todo"], cards: [{ issueId: f.issue.id, lane: lane.value }], hiddenLanes: ["todo"], collapsedLanes: [lane.value] })).board;
  expect(updated).toMatchObject({ revision: 2, filters: emptyIssueFilters, search: "hello" });
  expect((await f.request(f.reader, path, "PATCH", { revision: 1, name: "stale" })).status).toBe(409);
  expect((await f.request(f.reader, path, "PATCH", { name: "missing revision" })).status).toBe(400);
  expect((await f.call(f.admin, "/api/me/boards")).boards).toEqual([]);
  for (const method of ["GET", "PATCH", "DELETE"]) expect((await f.request(f.admin, path, method, method === "PATCH" ? { revision: 2 } : undefined)).status).toBe(404);
  expect((await f.call(f.admin, `/api/issues/${f.issue.id}`)).issue.projectId).toBe(f.project.id);
  expect((await f.call(f.admin, `/api/projects/${f.project.slug}/board`)).board.cards).toEqual([]);
  f.e.app.close(); f.e.app = createApp({ dataDir: f.e.dir });
  expect((await f.call(f.reader, path)).board).toEqual(updated);
  expect((await f.call(f.reader, "/api/me/boards")).boards).toEqual([updated]);
  await f.call(f.reader, path, "DELETE");
  expect((await f.request(f.reader, path)).status).toBe(404);
  expect(f.e.app.db.query("SELECT * FROM personal_board_cards").all()).toEqual([]);
});

test("read-only workspace members manage personal state; access revocation and workspace boundaries filter cards", async () => {
  const f = await fixture();
  await f.call(f.admin, "/api/workspaces/default/members/" + f.user.id, "PATCH", { defaultAccess: "read", projectAccess: [], convertLegacyAccess: true });
  const board = (await f.call(f.reader, "/api/me/boards", "POST", { name: "Read", cards: [{ issueId: f.issue.id, lane: "todo" }] })).board;
  expect((await f.request(f.reader, `/api/issues/${f.issue.id}`, "PATCH", { body: "No" })).status).toBe(403);
  await f.call(f.admin, "/api/workspaces", "POST", { name: "Other", slug: "other", visibility: "hidden" });
  const ownOther = (await f.call(f.admin, "/api/me/boards", "POST", { name: "Other" }, "other")).board;
  expect((await f.call(f.admin, "/api/me/boards")).boards).toEqual([]);
  expect((await f.request(f.admin, `/api/me/boards/${ownOther.id}`)).status).toBe(404);
  const foreign = (await f.call(f.admin, "/api/issues", "POST", { body: "Other" }, "other")).issue;
  expect((await f.request(f.admin, `/api/me/boards/${board.id}`, "GET", undefined, "other")).status).toBe(404);
  expect((await f.request(f.reader, `/api/me/boards/${board.id}`, "PATCH", { revision: 1, cards: [{ issueId: foreign.id, lane: "todo" }] })).status).toBe(404);
  await f.call(f.admin, "/api/workspaces/default/members/" + f.user.id, "PATCH", { defaultAccess: "none", projectAccess: [] });
  expect((await f.call(f.reader, `/api/me/boards/${board.id}`)).board.cards).toEqual([]);
  expect((await f.request(f.reader, `/api/me/boards/${board.id}`, "PATCH", { revision: 1, cards: [{ issueId: f.issue.id, lane: "todo" }] })).status).toBe(404);
  await f.call(f.reader, `/api/me/boards/${board.id}`, "PATCH", { revision: 1, name: "Renamed while revoked" });
  await f.call(f.reader, `/api/me/boards/${board.id}`, "PATCH", { revision: 2, cards: [] });
  await f.call(f.admin, "/api/workspaces/default/members/" + f.user.id, "PATCH", { defaultAccess: "read", projectAccess: [] });
  expect((await f.call(f.reader, `/api/me/boards/${board.id}`)).board.cards).toEqual([{ issueId: f.issue.id, lane: "todo" }]);
  await f.call(f.admin, "/api/workspaces/default/members/" + f.user.id, "DELETE");
  expect((await f.request(f.reader, `/api/me/boards/${board.id}`)).status).toBe(404);
});

test("removing a custom lane while access is revoked safely relocates hidden placements", async () => {
  const f = await fixture();
  const memberPath = "/api/workspaces/default/members/" + f.user.id;
  await f.call(f.admin, memberPath, "PATCH", { defaultAccess: "read", projectAccess: [], convertLegacyAccess: true });
  const custom = { value: `custom_${crypto.randomUUID()}`, label: "Review" };
  const board = (await f.call(f.reader, "/api/me/boards", "POST", {
    name: "Review", customLanes: [custom], lanes: [custom.value, "todo"], cards: [{ issueId: f.issue.id, lane: custom.value }],
  })).board;
  const path = `/api/me/boards/${board.id}`;
  await f.call(f.admin, memberPath, "PATCH", { defaultAccess: "none", projectAccess: [] });
  const hidden = (await f.call(f.reader, path, "PATCH", {
    revision: 1, name: "Renamed", customLanes: [], lanes: ["done", "todo"],
  })).board;
  expect(hidden.cards).toEqual([]);
  expect(hidden.revision).toBe(2);
  await f.call(f.admin, memberPath, "PATCH", { defaultAccess: "read", projectAccess: [] });
  expect((await f.call(f.reader, path)).board.cards).toEqual([{ issueId: f.issue.id, lane: "done" }]);
  const saved = (await f.call(f.reader, path, "PATCH", { revision: 2, search: "Still editable" })).board;
  expect(saved.revision).toBe(3);
  expect(saved.cards).toEqual([{ issueId: f.issue.id, lane: "done" }]);
  expect((await f.call(f.admin, `/api/projects/${f.project.slug}/board`)).board.cards).toEqual([]);
});

test("strict bounded filters and lane/card config reject invalid writes atomically", async () => {
  const f = await fixture();
  const condition = { id: "a", field: "title", operator: "is", value: "" };
  for (const input of [
    { filters: { conjunction: "xor", conditions: [] } },
    { filters: { conjunction: "and", conditions: [{ ...condition, field: "bad" }] } },
    { filters: { conjunction: "and", conditions: [{ ...condition, field: "state", value: "bad" }] } },
    { filters: { conjunction: "and", conditions: [{ ...condition, field: "created", value: "2026-02-31" }] } },
    { filters: { conjunction: "and", conditions: [condition, condition] } },
    { filters: { conjunction: "and", conditions: Array.from({ length: 51 }, (_, i) => ({ ...condition, id: String(i) })) } },
    { filters: { conjunction: "and", conditions: [{ ...condition, operator: "matchesEvery" }] } },
    { filters: { conjunction: "and", conditions: [], extra: true } },
    { lanes: ["unknown"] }, { lanes: ["todo", "todo"] }, { lanes: [] }, { hiddenLanes: ["unknown"] },
    { laneLabels: { todo: "Done" } }, { search: "x".repeat(1001) }, { userId: f.adminId }, { defaultFilters: null },
    { cards: [{ issueId: f.issue.id, lane: "unknown" }] },
  ]) expect((await f.request(f.reader, "/api/me/boards", "POST", { name: "Invalid", ...input })).status).toBe(400);
  expect((await f.call(f.reader, "/api/me/boards")).boards).toEqual([]);
  const filters = { conjunction: "and", conditions: [{ ...condition, field: "project", value: f.project.id }] };
  expect((await f.request(f.reader, "/api/me/boards", "POST", { name: "Project filter", filters })).status).toBe(201);
});

test("project defaults follow current owner rather than creator; empty, reset, validation and archived guard", async () => {
  const f = await fixture(), base = `/api/projects/${f.project.slug}/board`, path = `${base}/default-filters`;
  expect((await f.call(f.admin, base)).board.defaultFilters).toBeUndefined();
  await f.call(f.admin, path, "PATCH", { filters: emptyIssueFilters });
  expect((await f.call(f.reader, base)).board.defaultFilters).toEqual(emptyIssueFilters);
  expect((await f.request(f.reader, path, "PATCH", { filters: null })).status).toBe(403);
  await f.call(f.admin, `/api/projects/${f.project.slug}/access`, "PATCH", { ownerId: f.user.id });
  expect((await f.request(f.admin, path, "PATCH", { filters: null })).status).toBe(403);
  await f.call(f.reader, path, "PATCH", { filters: defaultIssueFilters });
  expect((await f.request(f.reader, base, "PATCH", { lanes: ["todo"] })).status).toBe(403);
  expect((await f.request(f.admin, base, "PATCH", { lanes: ["todo"] })).status).toBe(200);
  expect((await f.call(f.reader, base)).board.defaultFilters).toEqual(defaultIssueFilters);
  expect((await f.request(f.reader, path, "PATCH", { filters: { conjunction: "and", conditions: [{ id: "p", field: "project", operator: "is", value: f.project.id }] } })).status).toBe(400);
  await f.call(f.reader, path, "PATCH", { filters: null });
  expect((await f.call(f.reader, base)).board.defaultFilters).toBeUndefined();
  await f.call(f.admin, `/api/projects/${f.project.slug}`, "PATCH", { archived: true });
  expect((await f.request(f.reader, path, "PATCH", { filters: emptyIssueFilters })).status).toBe(409);
});

test("API scopes gate personal mutations; migration is idempotent with foreign-key cascades", async () => {
  const f = await fixture();
  const key = async (scopes: string[]) => (await f.call(f.reader, "/api/me/api-keys", "POST", { name: "Personal", scopes, expiresInDays: 1 })).token;
  const read = await key(["read"]), write = await key(["read", "write"]);
  expect((await f.request("", "/api/me/boards", "GET", undefined, "default", read)).status).toBe(200);
  expect((await f.request("", "/api/me/boards", "POST", { name: "No" }, "default", read)).status).toBe(403);
  const board = (await f.call("", "/api/me/boards", "POST", { name: "Yes", cards: [{ issueId: f.issue.id, lane: "todo" }] }, "default", write)).board;
  const path = `/api/me/boards/${board.id}`;
  expect((await f.request("", path, "DELETE", undefined, "default", read)).status).toBe(403);
  f.e.app.db.query("DELETE FROM issues WHERE id=?").run(f.issue.id);
  expect((await f.call(f.reader, path)).board.cards).toEqual([]);
  // Existing account tables intentionally restrict deletion; clear those test
  // references before exercising the personal-board user's cascade.
  for (const table of ["sessions", "verified_account_emails", "workspace_members"])
    f.e.app.db.query(`DELETE FROM ${table} WHERE userId=?`).run(f.user.id);
  f.e.app.db.query("DELETE FROM users WHERE id=?").run(f.user.id);
  expect(f.e.app.db.query("SELECT * FROM personal_boards").all()).toEqual([]);
  const db = openDatabase(join(f.e.dir, "app.sqlite"));
  expect(db.query("SELECT * FROM migrations WHERE version=24").all()).toHaveLength(1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
  const workspace = (await f.call(f.admin, "/api/workspaces", "POST", { name: "Cascade", slug: "cascade", visibility: "hidden" })).workspace;
  await f.call(f.admin, "/api/me/boards", "POST", { name: "Cascade" }, "cascade");
  f.e.app.db.query("DELETE FROM workspace_members WHERE workspaceId=?").run(workspace.id);
  f.e.app.db.query("DELETE FROM workspaces WHERE id=?").run(workspace.id);
  expect(f.e.app.db.query("SELECT * FROM personal_boards").all()).toEqual([]);
});

test("v23 upgrade is safely repeatable", async () => {
  const f = await fixture();
  f.e.app.close();
  const path = join(f.e.dir, "legacy.sqlite");
  const legacy = openDatabase(path, 23);
  expect(legacy.query("SELECT name FROM sqlite_schema WHERE name='personal_boards'").get()).toBeNull();
  legacy.close();
  for (let i = 0; i < 2; i++) {
    const upgraded = openDatabase(path);
    expect(upgraded.query("SELECT * FROM migrations WHERE version=24").all()).toHaveLength(1);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    upgraded.close();
  }
});
