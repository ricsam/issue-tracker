import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const run = crypto.randomUUID();
const manifest = join(tmpdir(), `board-order-${run}.json`);
const records: { dir: string; cleaned: boolean }[] = [];
const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
const save = () => writeFileSync(manifest, JSON.stringify({ run, records }));
save();
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), `board-order-${run}-`));
  records.push({ dir, cleaned: false }); save();
  const entry: (typeof owned)[number] = { dir }; owned.push(entry); return entry;
};
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app?.close(); rmSync(entry.dir, { recursive: true });
    records.find((r) => r.dir === entry.dir)!.cleaned = true; save();
  }
});
afterAll(() => rmSync(manifest));
async function fixture() {
  const entry = directory();
  const app = entry.app = createApp({ dataDir: entry.dir });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => entry.app!.request(path, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const project = (await (await req("/api/projects", "POST", { name: "Order" })).json()).project;
  const path = `/api/projects/${project.slug}`;
  const create = async (projectId: string | null = project.id) => (await (await req("/api/issues", "POST", { body: "Body #tag", projectId })).json()).issue.id as string;
  const ids = await Promise.all(Array.from({ length: 5 }, () => create()));
  const place = (issueIds: string[], lane = "todo", method = "PUT") => req(`${path}/board/issues`, method, { issueIds, lane });
  const reorder = (issueIds: string[], lane = "todo", beforeIssueId: string | null = null) => req(`${path}/board/issues/reorder`, "POST", { issueIds, lane, beforeIssueId });
  const cards = async (lane = "todo") => ((await (await req(`${path}/board`)).json()).board.cards as { issueId: string; lane: string }[]).filter((c) => c.lane === lane).map((c) => c.issueId);
  const snapshot = () => ["issues", "comments", "issue_tagged_users", "board_issues", "project_boards"].map((table) => entry.app!.db.query(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  return { app, entry, req, cookie, path, project, ids, create, place, reorder, cards, snapshot };
}

test("reorder block uses latest complete lane, filter-safe anchor, closed cards, retry no-op and restart persistence", async () => {
  const f = await fixture();
  const [a,b,c,d,e] = f.ids as [string,string,string,string,string];
  await f.place([a,b,c,d,e]);
  await f.req(`/api/issues/${c}`, "PATCH", { state: "closed" });
  await f.req(`/api/issues/${a}/comments`, "POST", { body: "Preserved comment" });
  const content = f.snapshot().slice(0, 3);
  const counts = (await (await f.req(f.path)).json()).project;
  // A filtered client only knows a and d; b/c/e still retain relative order.
  expect((await f.reorder([d], "todo", a)).status).toBe(200);
  expect(await f.cards()).toEqual([d,a,b,c,e]);
  // A later request does not replace the preceding user's order with stale IDs.
  expect((await f.reorder([c,b], "todo", a)).status).toBe(200);
  expect(await f.cards()).toEqual([d,c,b,a,e]);
  const before = f.snapshot();
  f.app.db.exec("CREATE TRIGGER no_updates BEFORE UPDATE ON board_issues BEGIN SELECT RAISE(ABORT,'no-op wrote'); END");
  expect((await f.reorder([c,b], "todo", a)).status).toBe(200);
  expect(f.snapshot()).toEqual(before);
  f.app.db.exec("DROP TRIGGER no_updates");
  expect(f.snapshot().slice(0, 3)).toEqual(content);
  expect((await (await f.req(f.path)).json()).project).toEqual(counts);
  f.entry.app!.close(); f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.cards()).toEqual([d,c,b,a,e]);
});

test("cross-lane blocks preserve remaining source order, hidden/custom sources and destination order", async () => {
  const f = await fixture();
  const [a,b,c,d,e] = f.ids as [string,string,string,string,string];
  const custom = `custom_${crypto.randomUUID()}`;
  await f.req(`${f.path}/board`, "PATCH", { lanes: ["todo", "done", custom], customLanes: [{ value: custom, label: "Review" }] });
  await f.place([a,b,c], custom); await f.place([d,e]);
  await f.req(`${f.path}/board`, "PATCH", { lanes: ["todo", "done"] });
  expect((await f.reorder([c,a], "todo", e)).status).toBe(200);
  expect(await f.cards(custom)).toEqual([b]);
  expect(await f.cards()).toEqual([d,c,a,e]);
  expect((await f.reorder([a,c], "done")).status).toBe(200);
  expect(await f.cards()).toEqual([d,e]);
  expect(await f.cards("done")).toEqual([a,c]);
  const project = (await (await f.req(f.path)).json()).project;
  expect([project.issueCount, project.openCount]).toEqual([5,3]);
});

test("compatibility routes append additions and cross-lane moves but preserve same-lane positions", async () => {
  const f = await fixture();
  const [a,b,c,d,e] = f.ids as [string,string,string,string,string];
  await f.place([c,a], "todo", "POST");
  expect(await f.cards()).toEqual([c,a]);
  await f.place([b], "done");
  await f.place([a,b,d]);
  expect(await f.cards()).toEqual([c,a,b,d]);
  await f.req(`${f.path}/board/issues/${a}`, "PATCH", { lane: "todo" });
  expect(await f.cards()).toEqual([c,a,b,d]);
  await f.place([e], "done");
  await f.req(`${f.path}/board/issues/${a}`, "PATCH", { lane: "done" });
  expect(await f.cards("done")).toEqual([e,a]);
  await f.req(`${f.path}/board/issues/${b}`, "DELETE");
  await f.place([b]);
  expect(await f.cards()).toEqual([c,d,b]);
});

test("invalid payloads, anchors, targets, archive, auth and CSRF never partially reorder", async () => {
  const f = await fixture();
  const [a,b,c] = f.ids as [string,string,string,string,string];
  await f.place([a,b]); await f.place([c], "done");
  const unlinked = await f.create(null);
  const other = (await (await f.req("/api/projects", "POST", { name: "Other" })).json()).project;
  const foreign = await f.create(other.id);
  const payload = { issueIds: [b], lane: "todo", beforeIssueId: a };
  const before = f.snapshot();
  const invalid = [null, {}, { ...payload, extra: true }, { ...payload, issueIds: [] }, { ...payload, issueIds: [b,b] },
    { ...payload, issueIds: ["bad"] }, { ...payload, issueIds: Array.from({ length: 1001 }, () => crypto.randomUUID()) },
    { ...payload, beforeIssueId: b }, { ...payload, beforeIssueId: c }, { ...payload, beforeIssueId: crypto.randomUUID() },
    { ...payload, beforeIssueId: "bad" }, { issueIds: [b], lane: "todo" }, { ...payload, lane: "unknown" },
    ...[unlinked, foreign, f.ids[4], crypto.randomUUID()].map((id) => ({ ...payload, issueIds: [b,id] }))];
  for (const input of invalid) {
    expect((await f.req(`${f.path}/board/issues/reorder`, "POST", input)).status).toBe(400);
    expect(f.snapshot()).toEqual(before);
  }
  expect((await f.req(`${f.path}/board/issues/reorder`, "POST", payload, "")).status).toBe(401);
  expect((await f.req(`${f.path}/board/issues/reorder`, "POST", payload, f.cookie, "https://evil.example")).status).toBe(403);
  await f.req(`${f.path}/board`, "PATCH", { lanes: ["done"] });
  expect((await f.reorder([b], "todo", a)).status).toBe(400);
  await f.req(f.path, "PATCH", { archived: true });
  expect((await f.reorder([b], "done", c)).status).toBe(409);
  expect(f.snapshot().slice(0,4)).toEqual(before.slice(0,4));
});

test("late storage error rolls back earlier order writes", async () => {
  const f = await fixture();
  await f.place(f.ids);
  const before = f.snapshot();
  f.app.db.exec(`CREATE TRIGGER reject_order BEFORE UPDATE ON board_issues WHEN NEW.issueId='${f.ids[0]}' BEGIN SELECT RAISE(ABORT,'forced'); END`);
  expect((await f.reorder([f.ids[4]!], "todo", f.ids[0]!)).status).toBe(409);
  expect(f.snapshot()).toEqual(before);
});

test("v10 preserves v9 hidden/custom memberships, ascending-number lane order and all content; idempotent", () => {
  const entry = directory(); const path = join(entry.dir, "migration.sqlite");
  let db = openDatabase(path);
  db.exec("DROP INDEX board_issues_order; ALTER TABLE board_issues DROP COLUMN position; DELETE FROM migrations WHERE version=10");
  db.exec(`INSERT INTO users VALUES ('u','User','user@example.com','admin','time',NULL);
    INSERT INTO projects VALUES ('p','p','P','','time',NULL,NULL);
    INSERT INTO project_boards VALUES ('p','["todo"]','[{"value":"custom_old","label":"Old"}]');`);
  for (const n of [3,1,2,4]) {
    db.query("INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (?,?,'p','Title','Body','todo','high','[]','u','time','time')").run(`i${n}`,n);
    db.query("INSERT INTO board_issues VALUES ('p',?,?)").run(`i${n}`, n === 4 ? "todo" : "custom_old");
  }
  db.exec("INSERT INTO comments VALUES ('c','i1','u','Comment','time','time'); INSERT INTO issue_tagged_users VALUES ('i1','u')");
  const tables = ["issues","comments","issue_tagged_users","project_boards"];
  const content = tables.map((t) => db.query(`SELECT * FROM ${t}`).all());
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    db = openDatabase(path);
    expect(tables.map((t) => db.query(`SELECT * FROM ${t}`).all())).toEqual(content);
    expect(db.query("SELECT issueId,lane FROM board_issues ORDER BY position").all()).toEqual([
      { issueId: "i1", lane: "custom_old" }, { issueId: "i2", lane: "custom_old" }, { issueId: "i3", lane: "custom_old" }, { issueId: "i4", lane: "todo" },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT version FROM migrations WHERE version=10").all()).toEqual([{ version: 10 }]);
    db.close();
  }
});
