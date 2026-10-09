import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { ISSUE_BODY_MAX_LENGTH } from "../shared/issue-content";
import { extractIssueLabels } from "../shared/labels";
import { mentionMarkdown } from "../shared/mentions";

// Record exact ownership before creating fixture contents; never glob-clean /tmp.
const run = crypto.randomUUID();
const manifest = join(tmpdir(), `bulk-labels-${run}.manifest.json`);
const records: { run: string; path: string; cleaned: boolean }[] = [];
const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
const saveManifest = () => writeFileSync(manifest, JSON.stringify({ run, manifest, records }, null, 2));
saveManifest();
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app?.close();
    rmSync(entry.dir, { recursive: true, force: true });
    records.find((record) => record.path === entry.dir)!.cleaned = true;
    saveManifest();
  }
});
afterAll(() => rmSync(manifest));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `bulk-labels-${run}-`));
  records.push({ run, path: dir, cleaned: false });
  saveManifest();
  const entry: (typeof owned)[number] = { dir };
  owned.push(entry);
  const app = entry.app = createApp({ dataDir: dir });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Origin: origin, Cookie: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (await setup.json()).user;
  const project = (await (await req("/api/projects", "POST", { name: "Labels" })).json()).project;
  const path = `/api/projects/${project.slug}`;
  const create = async (body = "Original") => {
    const response = await req(`${path}/issues`, "POST", { body });
    expect(response.status).toBe(200);
    return (await response.json()).issue;
  };
  const get = async (id: string) => (await (await req(`/api/issues/${id}`)).json()).issue;
  const label = (issueIds: string[], labels = ["new"]) => req(`${path}/issues/labels`, "POST", { issueIds, labels });
  return { app, req, admin, path, create, get, label, cookie };
}

test("bulk labels use latest content, preserve comments, title, lifecycle, board and mentions; duplicates are no-op", async () => {
  const f = await fixture();
  const a = await f.create("# Original\n\nKeep **formatting** and `code`. #existing");
  const b = await f.create("Second");
  expect((await f.req(`${f.path}/board/issues`, "POST", { issueIds: [a.id, b.id], lane: "todo" })).status).toBe(200);
  const comment = (await (await f.req(`/api/issues/${a.id}/comments`, "POST", { body: mentionMarkdown(f.admin) })).json()).comment;
  const before = (await (await f.req(`/api/issues/${a.id}`, "PATCH", { body: a.body + "\nLatest edit", state: "closed" })).json()).issue;
  const board = f.app.db.query("SELECT * FROM board_issues ORDER BY issueId").all();
  const response = await f.label([a.id, b.id], ["existing", "new", "new", "two-words"]);
  expect(response.status).toBe(200);
  const { issues } = await response.json();
  expect(issues[0]).toEqual({ ...before, body: before.body + "\n\n\\#new \\#two-words\n", labels: ["existing", "new", "two-words"], updatedAt: issues[0].updatedAt });
  expect(issues[1]).toEqual({ ...b, body: b.body + "\n\n\\#existing \\#new \\#two-words\n", labels: ["existing", "new", "two-words"], updatedAt: issues[1].updatedAt });
  expect((await (await f.req(`/api/issues/${a.id}`)).json()).comments).toEqual([comment]);
  expect(f.app.db.query("SELECT * FROM board_issues ORDER BY issueId").all()).toEqual(board);
  // A trigger proves existing labels do not update even updatedAt or resync mentions.
  f.app.db.exec("CREATE TRIGGER no_updates BEFORE UPDATE ON issues BEGIN SELECT RAISE(ABORT, 'unexpected update'); END;");
  expect(await (await f.label([a.id, b.id], ["new", "existing", "new", "two-words"])).json()).toEqual({ issues });
});

test("strict payload, ID and label limits reject without writes", async () => {
  const f = await fixture();
  const a = await f.create();
  const valid = { issueIds: [a.id], labels: ["ok"] };
  const invalid = [null, {}, { ...valid, extra: true }, { ...valid, issueIds: [] },
    { ...valid, issueIds: [a.id, a.id] }, { ...valid, issueIds: ["bad"] },
    { ...valid, issueIds: Array.from({ length: 1001 }, () => crypto.randomUUID()) },
    { ...valid, issueIds: a.id }, { ...valid, labels: [] }, { ...valid, labels: "ok" },
    { ...valid, labels: [null] }, { ...valid, labels: ["   "] }, { ...valid, labels: ["x".repeat(51)] },
    { ...valid, labels: Array.from({ length: 31 }, (_, i) => `label${i}`) }];
  for (const input of invalid) expect((await f.req(`${f.path}/issues/labels`, "POST", input)).status).toBe(400);
  expect((await f.req(`${f.path}/issues/labels`, "POST")).status).toBe(400);
  expect(await f.get(a.id)).toEqual(a);
  const labels = Array.from({ length: 30 }, (_, i) => i === 0 ? "x".repeat(50) : `label${i}`);
  expect((await f.label([a.id], labels)).status).toBe(200);
  expect((await f.get(a.id)).labels).toEqual(labels);
});

test("unknown and foreign IDs, body size and aggregate labels roll back earlier targets", async () => {
  const f = await fixture();
  const a = await f.create();
  const full = await f.create("x".repeat(ISSUE_BODY_MAX_LENGTH));
  const many = await f.create(Array.from({ length: 30 }, (_, i) => `#label${i}`).join(" "));
  const other = (await (await f.req("/api/projects", "POST", { name: "Other" })).json()).project;
  const foreign = (await (await f.req(`/api/projects/${other.slug}/issues`, "POST", { body: "Foreign" })).json()).issue;
  for (const [target, status] of [[full.id, 400], [many.id, 400], [foreign.id, 400], ["999999", 404], [crypto.randomUUID(), 400]] as const) {
    expect((await f.label([a.id, target])).status).toBe(status);
    expect(await f.get(a.id)).toEqual(a);
  }
  for (const original of [full, many, foreign]) expect(await f.get(original.id)).toEqual(original);
  // Existing aggregate tags are deduplicated, not counted twice.
  expect((await f.label([many.id], ["label0", "label0"])).status).toBe(200);
  expect(await f.get(many.id)).toEqual(many);
  const boundary = await f.create("x".repeat(ISSUE_BODY_MAX_LENGTH - "\n\n\\#new\n".length));
  expect((await f.label([boundary.id])).status).toBe(200);
  expect((await f.get(boundary.id)).body.length).toBe(ISSUE_BODY_MAX_LENGTH);
});

test("auth, CSRF, unknown and archived project guards prevent writes", async () => {
  const f = await fixture();
  const a = await f.create();
  const payload = { issueIds: [a.id], labels: ["new"] };
  expect((await f.req(`${f.path}/issues/labels`, "POST", payload, "")).status).toBe(401);
  expect((await f.req(`${f.path}/issues/labels`, "POST", payload, f.cookie, "https://evil.example")).status).toBe(403);
  expect((await f.req("/api/projects/missing/issues/labels", "POST", payload)).status).toBe(404);
  expect((await f.req(f.path, "PATCH", { archived: true })).status).toBe(200);
  expect((await f.label([a.id])).status).toBe(409);
  expect(await f.get(a.id)).toEqual(a);
});

test("storage failures in issue updates and mention synchronization roll back the whole batch", async () => {
  const f = await fixture();
  const a = await f.create(mentionMarkdown(f.admin));
  const b = await f.create(mentionMarkdown(f.admin));
  for (const sql of [
    `CREATE TRIGGER reject_write BEFORE UPDATE ON issues WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`,
    `CREATE TRIGGER reject_write BEFORE INSERT ON issue_tagged_users WHEN NEW.issueId='${b.id}' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`,
  ]) {
    f.app.db.exec(sql);
    expect((await f.label([a.id, b.id])).status).toBe(409);
    expect(await f.get(a.id)).toEqual(a);
    expect(await f.get(b.id)).toEqual(b);
    f.app.db.exec("DROP TRIGGER reject_write");
  }
});

test("unclosed Markdown retains original content and title with visible, idempotent labels", async () => {
  const f = await fixture();
  for (const body of ["```\ncode", "Title\n=====\n\n~~~\ncode", "# Title\n\n<!-- unfinished", "# Title\n\n<script>\nunclosed", "# Title\n\n```\n#new"]) {
    const original = await f.create(body);
    const response = await f.label([original.id], ["new", "two-words"]);
    expect(response.status).toBe(200);
    const result = (await response.json()).issues[0];
    expect(result.title).toBe(original.title);
    expect(result.body).toContain(body.startsWith("# Title") ? body.slice("# Title\n".length) : body);
    expect(extractIssueLabels(result.body)).toEqual(["new", "two-words"]);
    expect(await (await f.label([original.id], ["new", "two-words"])).json()).toEqual({ issues: [result] });
  }
});
