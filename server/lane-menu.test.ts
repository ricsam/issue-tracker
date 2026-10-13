import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";
import { orderedLanes } from "../shared/board";

const run = crypto.randomUUID();
const manifest = join(tmpdir(), `lane-menu-${run}.json`);
const records: { dir: string; cleaned: boolean }[] = [];
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
const save = () => writeFileSync(manifest, JSON.stringify({ run, records }));
save();
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app.close(); rmSync(entry.dir, { recursive: true });
    records.find((record) => record.dir === entry.dir)!.cleaned = true; save();
  }
});
afterAll(() => rmSync(manifest));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `lane-menu-${run}-`));
  records.push({ dir, cleaned: false }); save();
  const entry = { dir, app: createApp({ dataDir: dir }) }; owned.push(entry);
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => entry.app.request(path, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const project = (await (await req("/api/projects", "POST", { name: "Lanes", visibility: "private" })).json()).project;
  const path = `/api/projects/${project.slug}`;
  const get = async () => (await (await req(`${path}/board`)).json()).board;
  const set = (body: unknown) => req(`${path}/board`, "PATCH", body);
  const patch = (lane: string, body: unknown) => req(`${path}/board/lanes/${lane}`, "PATCH", body);
  const remove = (lane: string) => req(`${path}/board/lanes/${lane}`, "DELETE");
  const content = () => ["issues", "board_issues", "issue_history", "comments"].map((table) => entry.app.db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
  return { entry, req, cookie, project, path, get, set, patch, remove, content };
}
const custom = () => ({ value: `custom_${crypto.randomUUID()}`, label: "Review" });

test("rename default/custom lanes, reorder compatibility, reset and restart preserve content and stable IDs", async () => {
  const f = await fixture(); const review = custom();
  expect((await f.get()).laneLabels).toBeUndefined();
  await f.set({ lanes: ["todo", review.value, "done"], customLanes: [review] });
  const issue = (await (await f.req("/api/issues", "POST", { projectId: f.project.id, body: "Keep me", lane: review.value })).json()).issue;
  const before = f.content();
  expect((await f.patch("todo", { label: "  Planned  " })).status).toBe(200);
  expect((await f.patch(review.value, { label: "Quality", index: 99 })).status).toBe(200);
  expect(f.content()).toEqual(before);
  expect(await f.get()).toEqual({ lanes: ["todo", "done", review.value], customLanes: [review], laneLabels: { todo: "Planned", [review.value]: "Quality" }, cards: [{ issueId: issue.id, lane: review.value }] });
  f.entry.app.close(); f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(orderedLanes((await f.get()).lanes, [review], (await f.get()).laneLabels).map((lane) => lane.label)).toEqual(["Planned", "Done", "Quality"]);
  expect((await f.patch(review.value, { index: 0 })).status).toBe(200);
  expect((await f.get()).laneLabels[review.value]).toBe("Quality");
  await f.req(`${f.path}/board/issues/${issue.id}`, "PATCH", { lane: "todo" });
  const history = (await (await f.req(`/api/issues/${issue.id}/history`)).json()).history;
  expect(history[0].changes).toContainEqual({ field: "boardLane", before: "Quality", after: "Planned" });
  await f.patch("todo", { label: "Todo" }); await f.patch(review.value, { label: "Review" });
  expect((await f.get()).laneLabels).toBeUndefined();
});

test("labels validate against effective names including removed lanes; invalid combined updates are atomic", async () => {
  const f = await fixture(); const review = custom();
  await f.set({ lanes: ["todo", "done", review.value], customLanes: [review] });
  await f.patch(review.value, { label: "Quality" }); await f.remove(review.value);
  for (const body of [{}, null, { label: "" }, { label: "   " }, { label: "x".repeat(61) }, { label: 1 }, { label: null }, { label: "x", extra: true }, { label: "done", index: 0 }, { label: "QUALITY", index: 0 }, { index: -1 }, { index: 0.5 }]) {
    const before = await f.get();
    expect((await f.patch("todo", body)).status).toBe(400);
    expect(await f.get()).toEqual(before);
  }
  expect((await f.patch("unknown", { label: "X" })).status).toBe(404);
  expect((await f.patch(review.value, { label: "X" })).status).toBe(400);
  const next = { ...custom(), label: "quality" };
  expect((await f.set({ lanes: ["todo", next.value], customLanes: [next] })).status).toBe(400);
  // A renamed lane's old name is available; resending the immutable original definition is valid.
  const oldName = custom();
  expect((await f.set({ lanes: ["todo", oldName.value], customLanes: [review, oldName] })).status).toBe(200);
  expect((await f.get()).laneLabels[review.value]).toBe("Quality");
});

test("remove preserves cards, definitions, overrides and current ordering, rejects last lane, and restores after restart", async () => {
  const f = await fixture(); const review = custom();
  await f.set({ lanes: ["todo", review.value, "done"], customLanes: [review] });
  for (const lane of ["todo", review.value]) await f.req("/api/issues", "POST", { projectId: f.project.id, body: "Untouched", lane });
  await f.patch(review.value, { label: "Quality" });
  const content = f.content();
  await f.patch("done", { index: 0 });
  expect((await f.remove("todo")).status).toBe(200);
  expect((await f.get()).lanes).toEqual(["done", review.value]);
  expect((await f.remove(review.value)).status).toBe(200);
  expect((await f.remove(review.value)).status).toBe(200);
  expect((await f.remove("done")).status).toBe(400);
  expect((await f.remove("unknown")).status).toBe(404);
  expect(f.content()).toEqual(content);
  f.entry.app.close(); f.entry.app = createApp({ dataDir: f.entry.dir });
  expect((await f.get()).lanes).toEqual(["done"]);
  await f.set({ lanes: [review.value, "todo", "done"] });
  expect((await f.get()).customLanes).toEqual([review]);
  expect((await f.get()).laneLabels).toEqual({ [review.value]: "Quality" });
  expect(f.content()).toEqual(content);
});

test("rename/remove enforce authentication, CSRF, private project visibility and archive protection", async () => {
  const f = await fixture(); const before = await f.get();
  f.entry.app.db.query("INSERT INTO users (id,name,email,role,createdAt,password) VALUES ('outsider','Other','other@example.com','member','now',?)")
    .run(await Bun.password.hash("long-password-123"));
  const login = await f.req("/api/auth/login", "POST", { email: "other@example.com", password: "long-password-123" }, "");
  const outsider = login.headers.get("set-cookie")!.split(";")[0]!;
  for (const method of ["PATCH", "DELETE"]) {
    const body = method === "PATCH" ? { label: "New" } : undefined;
    expect((await f.req(`${f.path}/board/lanes/todo`, method, body, "")).status).toBe(401);
    expect((await f.req(`${f.path}/board/lanes/todo`, method, body, f.cookie, "https://evil.example")).status).toBe(403);
    expect((await f.req(`${f.path}/board/lanes/todo`, method, body, outsider)).status).toBe(404);
  }
  await f.req(f.path, "PATCH", { archived: true });
  expect((await f.patch("todo", { label: "New" })).status).toBe(409);
  expect((await f.remove("todo")).status).toBe(409);
  expect(await f.get()).toEqual(before);
});

test("v16 additive migration defaults existing board overrides to empty and reruns safely", async () => {
  const f = await fixture(); const path = join(f.entry.dir, "migration.sqlite");
  let db = openDatabase(path, 15);
  db.exec(`INSERT INTO projects (id,slug,name,description,createdAt) VALUES ('p','p','P','','now');
    INSERT INTO project_boards VALUES ('p','["todo"]','[]');`);
  db.close();
  for (let i = 0; i < 2; i++) {
    db = openDatabase(path);
    try {
      expect(db.query("SELECT * FROM project_boards").all()).toEqual([{ projectId: "p", lanes: '["todo"]', customLanes: "[]", laneLabels: "{}" }]);
      expect(db.query("SELECT version FROM migrations WHERE version=16").all()).toEqual([{ version: 16 }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }
});
