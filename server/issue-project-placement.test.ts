import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { mentionMarkdown } from "../shared/mentions";

// Exact resources created by this run, retained until the owning app closes.
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "issue-project-placement-"));
  const app = createApp({ dataDir: dir });
  owned.push({ dir, app });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
    method,
    headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "placement@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const user = (await setup.json()).user;
  const source = (await (await req("/api/projects", "POST", { name: "Source" })).json()).project;
  const target = (await (await req("/api/projects", "POST", { name: "Target" })).json()).project;
  const board = async (p = source) => (await (await req(`/api/projects/${p.slug}/board`)).json()).board;
  const create = async (extra = {}) => {
    const response = await req("/api/issues", "POST", { body: "# Issue", projectId: source.id, ...extra });
    expect(response.status).toBe(200);
    return response.json();
  };
  const detail = async (id: string) => (await req(`/api/issues/${id}`)).json();
  const archive = (p: typeof source) => req(`/api/projects/${p.slug}`, "PATCH", { archived: true });
  return { app, req, user, source, target, board, create, detail, archive };
}

test("project moves preserve identity, content, comments, tags and lifecycle; same-project keeps placement", async () => {
  const f = await fixture();
  const { issue } = await f.create({ body: "# Keep me\n\nOriginal body", labels: ["bug"], lane: "todo" });
  await f.req(`/api/issues/${issue.id}/comments`, "POST", { body: mentionMarkdown(f.user) });
  await f.req(`/api/issues/${issue.id}`, "PATCH", { state: "closed" });
  const before = await f.detail(issue.id);
  const placement = f.app.db.query("SELECT * FROM board_issues WHERE issueId=?").get(issue.id);
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.source.id })).status).toBe(200);
  expect(f.app.db.query("SELECT * FROM board_issues WHERE issueId=?").get(issue.id)).toEqual(placement);
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.target.id })).status).toBe(200);
  const moved = await f.detail(issue.id);
  expect(moved).toEqual({ ...before, issue: { ...before.issue, projectId: f.target.id, updatedAt: moved.issue.updatedAt } });
  expect(moved.issue.taggedUserIds).toEqual([f.user.id]);
  expect((await f.board()).cards).toEqual([]);
  expect((await f.board(f.target)).cards).toEqual([]);
  expect((await (await f.req(`/api/projects/${f.source.slug}/issues`)).json()).issues).toEqual([]);
  expect((await (await f.req(`/api/projects/${f.target.slug}/issues`)).json()).issues.map((i: any) => i.id)).toEqual([issue.id]);
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: null })).status).toBe(200);
  const unlinked = await f.detail(issue.id);
  expect(unlinked.issue).toEqual({ ...before.issue, projectId: null, updatedAt: unlinked.issue.updatedAt });
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.source.id, body: "# Edited", state: "open" })).status).toBe(200);
  expect((await f.detail(issue.id)).issue).toMatchObject({ id: issue.id, number: issue.number, projectId: f.source.id, body: "# Edited", state: "open", closedAt: null, closedById: null });
});

test("invalid or archived moves reject all edits and preserve placement; PATCH still rejects lane", async () => {
  const f = await fixture();
  const { issue } = await f.create({ lane: "todo" });
  const before = await f.detail(issue.id);
  const board = await f.board();
  for (const [projectId, status] of [["missing", 404], ["", 400], [42, 400], [{}, 400], [[], 400]] as const) {
    expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId, body: "# Changed", state: "closed" })).status).toBe(status);
    expect(await f.detail(issue.id)).toEqual(before);
    expect(await f.board()).toEqual(board);
  }
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.target.id, lane: "todo" })).status).toBe(400);
  const missingMention = mentionMarkdown({ id: crypto.randomUUID(), name: "Missing" });
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.target.id, body: missingMention })).status).toBe(400);
  expect(await f.detail(issue.id)).toEqual(before);
  expect(await f.board()).toEqual(board);
  await f.archive(f.target);
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: f.target.id, body: "# Changed" })).status).toBe(409);
  await f.archive(f.source);
  for (const projectId of [null, f.source.id, f.target.id])
    expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId })).status).toBe(409);
  expect(await f.detail(issue.id)).toEqual(before);
  expect(await f.board()).toEqual(board);
  expect((await f.req("/api/issues/999999", "PATCH", { projectId: null })).status).toBe(404);
});

test("creation appends to visible default/custom lanes through both endpoints and returns the target board", async () => {
  const f = await fixture();
  const custom = { value: `custom_${crypto.randomUUID()}`, label: "Review" };
  await f.req(`/api/projects/${f.target.slug}/board`, "PATCH", { lanes: ["todo", custom.value], customLanes: [custom] });
  for (const lane of ["todo", custom.value]) {
    const first = await f.create({ projectId: f.target.id, lane });
    const secondResponse = await f.req(`/api/projects/${f.target.slug}/issues`, "POST", { body: "# Second", lane });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.issue.projectId).toBe(f.target.id);
    expect(second.board).toEqual(await f.board(f.target));
    expect(second.board.cards.filter((c: any) => c.lane === lane)).toEqual([
      { issueId: first.issue.id, lane }, { issueId: second.issue.id, lane },
    ]);
    expect(first.board.cards.filter((c: any) => c.lane === lane).at(-1)).toEqual({ issueId: first.issue.id, lane });
  }
  expect((await f.board()).cards).toEqual([]);
  for (const projectId of [null, f.source.id]) {
    for (const lane of [undefined, null]) {
      const result = await f.create({ projectId, lane });
      expect(result.board).toBeUndefined();
      expect(result.issue.projectId).toBe(projectId);
      expect(f.app.db.query("SELECT * FROM board_issues WHERE issueId=?").get(result.issue.id)).toBeNull();
    }
  }
});

test("creation rejects invalid, hidden, foreign, unlinked and archived lane inputs without partial writes", async () => {
  const f = await fixture();
  const custom = { value: `custom_${crypto.randomUUID()}`, label: "Review" };
  await f.req(`/api/projects/${f.source.slug}/board`, "PATCH", { lanes: ["todo"], customLanes: [custom] });
  const before = await f.board();
  for (const endpoint of ["/api/issues", `/api/projects/${f.source.slug}/issues`]) {
    for (const lane of ["", "unknown", "done", custom.value, `custom_${crypto.randomUUID()}`, 42, [], {}, "x".repeat(101)]) {
      expect((await f.req(endpoint, "POST", { body: "# Rejected", ...(endpoint === "/api/issues" ? { projectId: f.source.id } : {}), lane })).status).toBe(400);
    }
  }
  for (const projectId of [undefined, null])
    expect((await f.req("/api/issues", "POST", { body: "# Unlinked", projectId, lane: "todo" })).status).toBe(400);
  expect((await f.req("/api/issues", "POST", { body: "# Missing", projectId: "missing", lane: "todo" })).status).toBe(404);
  await f.req(`/api/projects/${f.source.slug}/board`, "PATCH", { lanes: ["todo", custom.value] });
  expect((await f.req("/api/issues", "POST", { body: "# Foreign", projectId: f.target.id, lane: custom.value })).status).toBe(400);
  await f.req(`/api/projects/${f.source.slug}/board`, "PATCH", { lanes: ["todo"] });
  await f.archive(f.source);
  for (const endpoint of ["/api/issues", `/api/projects/${f.source.slug}/issues`])
    expect((await f.req(endpoint, "POST", { body: "# Archived", ...(endpoint === "/api/issues" ? { projectId: f.source.id } : {}), lane: "todo" })).status).toBe(409);
  expect((await (await f.req("/api/issues")).json()).issues).toEqual([]);
  expect(await f.board()).toEqual(before);
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM issue_tagged_users").get()).toEqual({ n: 0 });
});

test("unlink removes board membership; storage failures roll back moves and combined edits", async () => {
  const f = await fixture();
  const { issue } = await f.create({ lane: "todo" });
  const before = await f.detail(issue.id);
  const board = await f.board();
  f.app.db.exec("CREATE TRIGGER move_failure BEFORE UPDATE OF projectId ON issues BEGIN SELECT RAISE(ABORT, 'forced move failure'); END");
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: null, body: "# Changed", state: "closed" })).status).toBe(409);
  expect(await f.detail(issue.id)).toEqual(before);
  expect(await f.board()).toEqual(board);
  f.app.db.exec("DROP TRIGGER move_failure");
  expect((await f.req(`/api/issues/${issue.id}`, "PATCH", { projectId: null })).status).toBe(200);
  expect((await f.detail(issue.id)).issue.projectId).toBeNull();
  expect((await f.board()).cards).toEqual([]);
});

test("board insertion failure rolls back issue, global number allocation and tag associations", async () => {
  const f = await fixture();
  const first = await f.create();
  f.app.db.exec("CREATE TRIGGER placement_failure BEFORE INSERT ON board_issues BEGIN SELECT RAISE(ABORT, 'forced placement failure'); END");
  const response = await f.req("/api/issues", "POST", { body: `# Roll back\n\n${mentionMarkdown(f.user)}`, projectId: f.source.id, lane: "todo" });
  expect(response.status).toBe(409);
  expect((await (await f.req("/api/issues")).json()).issues).toHaveLength(1);
  expect((await f.board()).cards).toEqual([]);
  expect(f.app.db.query("SELECT COUNT(*) AS n FROM issue_tagged_users").get()).toEqual({ n: 0 });
  f.app.db.exec("DROP TRIGGER placement_failure");
  const next = await f.create({ lane: "todo" });
  expect(next.issue.number).toBe(first.issue.number + 1);
});
