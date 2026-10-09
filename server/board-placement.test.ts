import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { mentionMarkdown } from "../shared/mentions";

const run = crypto.randomUUID();
const manifest = join(tmpdir(), `board-placement-${run}.json`);
const records: { path: string; cleaned: boolean }[] = [];
const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
const save = () => writeFileSync(manifest, JSON.stringify({ run, records }));
save();
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app?.close();
    rmSync(entry.dir, { recursive: true });
    records.find((record) => record.path === entry.dir)!.cleaned = true;
    save();
  }
});
afterAll(() => rmSync(manifest));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `board-placement-${run}-`));
  records.push({ path: dir, cleaned: false }); save();
  const entry: (typeof owned)[number] = { dir }; owned.push(entry);
  const app = entry.app = createApp({ dataDir: dir });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const user = (await setup.json()).user;
  const project = (await (await req("/api/projects", "POST", { name: "Project" })).json()).project;
  const path = `/api/projects/${project.slug}`;
  const create = async (projectId: string | null = project.id) => {
    const response = await req("/api/issues", "POST", { projectId, body: `# Title\n\nBody #label ${mentionMarkdown(user)}` });
    expect(response.status).toBe(200);
    return (await response.json()).issue;
  };
  const put = (issueIds: string[], lane = "todo") => req(`${path}/board/issues`, "PUT", { issueIds, lane });
  const snapshot = () => ["issues", "comments", "issue_tagged_users", "board_issues", "project_boards"].map((table) => app.db.query(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  const counts = async () => {
    const p = (await (await req(path)).json()).project;
    return [p.issueCount, p.openCount];
  };
  return { app, req, path, project, user, cookie, create, put, snapshot, counts };
}

test("PUT atomically adds and moves mixed open work, custom lanes, idempotence and preservation", async () => {
  const f = await fixture();
  const a = await f.create(), b = await f.create();
  await f.req(`/api/issues/${a.id}/comments`, "POST", { body: mentionMarkdown(f.user) });
  expect((await f.req(`${f.path}/board/issues`, "POST", { issueIds: [a.id], lane: "todo" })).status).toBe(200);
  const custom = `custom_${crypto.randomUUID()}`;
  expect((await f.req(`${f.path}/board`, "PATCH", { lanes: ["todo", "done", custom], customLanes: [{ value: custom, label: "Review" }] })).status).toBe(200);
  const content = f.snapshot().slice(0, 3);
  expect(await f.counts()).toEqual([2, 1]);
  let response = await f.put([a.id, b.id], custom);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.board.cards).toEqual([{ issueId: a.id, lane: custom }, { issueId: b.id, lane: custom }]);
  expect(await f.counts()).toEqual([2, 2]);
  expect(f.snapshot().slice(0, 3)).toEqual(content);
  f.app.db.exec("CREATE TRIGGER no_board_updates BEFORE UPDATE ON board_issues BEGIN SELECT RAISE(ABORT,'unexpected update'); END");
  expect(await (await f.put([a.id, b.id], custom)).json()).toEqual(result);
  f.app.db.exec("DROP TRIGGER no_board_updates");
  expect((await f.put([a.id, b.id], "done")).status).toBe(200);
  expect(await f.counts()).toEqual([2, 0]);
  expect(f.snapshot().slice(0, 3)).toEqual(content);
});

test("closed existing hidden members may move; closed off-board issues reject whole batch until reopened", async () => {
  const f = await fixture();
  const a = await f.create(), b = await f.create(), c = await f.create();
  await f.put([a.id], "in_progress");
  await f.req(`${f.path}/board`, "PATCH", { lanes: ["todo", "done"] });
  for (const i of [a, b]) await f.req(`/api/issues/${i.id}`, "PATCH", { state: "closed" });
  const content = f.snapshot().slice(0, 3);
  expect((await f.put([a.id], "done")).status).toBe(200);
  expect(f.snapshot().slice(0, 3)).toEqual(content);
  const before = f.snapshot();
  expect((await f.put([c.id, a.id, b.id], "todo")).status).toBe(409);
  expect(f.snapshot()).toEqual(before);
  expect(await f.counts()).toEqual([3, 0]);
  await f.req(`/api/issues/${b.id}`, "PATCH", { state: "open" });
  expect((await f.put([c.id, a.id, b.id], "todo")).status).toBe(200);
  expect(await f.counts()).toEqual([3, 2]);
});

test("strict validation, unknown/foreign/unlinked targets, hidden lanes and archives leave all state unchanged", async () => {
  const f = await fixture();
  const a = await f.create();
  const unlinked = await f.create(null);
  const other = (await (await f.req("/api/projects", "POST", { name: "Other" })).json()).project;
  const foreign = await f.create(other.id);
  await f.put([a.id], "todo");
  await f.req(`${f.path}/board`, "PATCH", { lanes: ["todo", "done"] });
  const before = f.snapshot();
  const payload = { issueIds: [a.id], lane: "done" };
  const invalid = [null, {}, { ...payload, extra: true }, { ...payload, issueIds: [] },
    { ...payload, issueIds: [a.id, a.id] }, { ...payload, issueIds: [a.id, "bad"] },
    { ...payload, issueIds: Array.from({ length: 1001 }, () => crypto.randomUUID()) },
    { ...payload, lane: "" }, { ...payload, lane: 1 }, { ...payload, lane: "in_progress" },
    { ...payload, lane: `custom_${crypto.randomUUID()}` },
    ...[unlinked.id, foreign.id, crypto.randomUUID()].map((id) => ({ ...payload, issueIds: [a.id, id] }))];
  for (const input of invalid) {
    expect((await f.req(`${f.path}/board/issues`, "PUT", input)).status).toBe(400);
    expect(f.snapshot()).toEqual(before);
  }
  expect((await f.req(`${f.path}/board/issues`, "PUT")).status).toBe(400);
  expect((await f.req("/api/projects/missing/board/issues", "PUT", payload)).status).toBe(404);
  await f.req(f.path, "PATCH", { archived: true });
  expect((await f.put([a.id], "done")).status).toBe(409);
  expect(f.snapshot()).toEqual(before);
  expect(await f.counts()).toEqual([1, 1]); // unlinked and foreign do not contribute
});

test("authentication, same-origin protection and member collaboration", async () => {
  const f = await fixture();
  const a = await f.create();
  const payload = { issueIds: [a.id], lane: "todo" };
  expect((await f.req(`${f.path}/board/issues`, "PUT", payload, "")).status).toBe(401);
  expect((await f.req(`${f.path}/board/issues`, "PUT", payload, f.cookie, "https://evil.example")).status).toBe(403);
  expect(f.app.db.query("SELECT * FROM board_issues").all()).toEqual([]);
  await f.req("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password: "long-password-123" });
  const login = await f.req("/api/auth/login", "POST", { email: "member@example.com", password: "long-password-123" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect((await f.req(`${f.path}/board/issues`, "PUT", payload, cookie)).status).toBe(200);
});

test("a late storage failure rolls back both added and moved memberships", async () => {
  const f = await fixture();
  const a = await f.create(), b = await f.create(), c = await f.create();
  await f.put([a.id], "todo");
  const before = f.snapshot();
  f.app.db.exec(`CREATE TRIGGER reject_placement BEFORE INSERT ON board_issues WHEN NEW.issueId='${c.id}' BEGIN SELECT RAISE(ABORT,'forced failure'); END`);
  expect((await f.put([a.id, b.id, c.id], "done")).status).toBe(409);
  expect(f.snapshot()).toEqual(before);
});
