import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { STATUSES } from "../shared/types";

// This manifest contains only resources created by this test run.
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const entry of owned.splice(0)) {
    entry.app.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "issue-board-test-"));
  const entry = { dir, app: createApp({ dataDir: dir }) };
  owned.push(entry);
  let cookie = "";
  const req = (
    path: string,
    method = "GET",
    body?: unknown,
    auth = true,
    origin = "http://localhost:3000",
  ) =>
    entry.app.request(path, {
      method,
      headers: {
        Origin: origin,
        Cookie: auth ? cookie : "",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const setup = await req("/api/auth/setup", "POST", {
    name: "Admin",
    email: "board@example.com",
    password: "long-password-123",
  });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const project = (
    await (await req("/api/projects", "POST", { name: "Board" })).json()
  ).project;
  const path = `/api/projects/${project.slug}`;
  const get = async () => (await (await req(`${path}/board`)).json()).board;
  const set = (body: unknown) => req(`${path}/board`, "PATCH", body);
  const create = (extra = {}) =>
    req(`${path}/issues`, "POST", { title: "Issue", body: "", ...extra });
  return { entry, req, project, path, get, set, create };
}
const defaults = { lanes: STATUSES.map((s) => s.value), issueIds: null };

test("board defaults, auth/CSRF, shared member edits, canonical lanes and restart persistence", async () => {
  const f = await fixture();
  expect(await f.get()).toEqual(defaults);
  expect((await f.req(`${f.path}/board`, "GET", undefined, false)).status).toBe(
    401,
  );
  expect(
    (await f.req(`${f.path}/board`, "PATCH", defaults, false)).status,
  ).toBe(401);
  expect(
    (
      await f.req(
        `${f.path}/board`,
        "PATCH",
        defaults,
        true,
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect((await f.req("/api/projects/missing/board")).status).toBe(404);
  expect(
    (await f.req("/api/projects/missing/board", "PATCH", defaults)).status,
  ).toBe(404);
  const member = {
    name: "Member",
    email: "member@example.com",
    password: "long-password-123",
  };
  expect((await f.req("/api/admin/users", "POST", member)).status).toBe(200);
  const login = await f.req(
    "/api/auth/login",
    "POST",
    { email: member.email, password: member.password },
    false,
  );
  const response = await f.entry.app.request(`${f.path}/board`, {
    method: "PATCH",
    headers: {
      Origin: "http://localhost:3000",
      Cookie: login.headers.get("set-cookie")!.split(";")[0]!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ lanes: ["done", "todo"], issueIds: [] }),
  });
  expect(response.status).toBe(200);
  const saved = { lanes: ["todo", "done"], issueIds: [] };
  expect(await f.get()).toEqual(saved);
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.get()).toEqual(saved);
});

test("full board validation and project membership reject without mutations", async () => {
  const f = await fixture();
  const issue = (await (await f.create()).json()).issue;
  const other = (
    await (await f.req("/api/projects", "POST", { name: "Other" })).json()
  ).project;
  const foreign = (
    await (
      await f.req(`/api/projects/${other.slug}/issues`, "POST", {
        title: "Foreign",
        body: "",
      })
    ).json()
  ).issue;
  const saved = { lanes: ["todo"], issueIds: [issue.id] };
  expect((await f.set(saved)).status).toBe(200);
  for (const invalid of [
    {},
    { lanes: ["todo"] },
    { issueIds: null },
    { ...saved, lanes: [] },
    { ...saved, lanes: ["todo", "todo"] },
    { ...saved, lanes: ["unknown"] },
    { ...saved, extra: true },
    { ...saved, issueIds: [issue.id, issue.id] },
    { ...saved, issueIds: ["bad"] },
    { ...saved, issueIds: [crypto.randomUUID()] },
    { ...saved, issueIds: [issue.id, foreign.id] },
    { ...saved, issueIds: "all" },
  ]) {
    expect((await f.set(invalid)).status).toBe(400);
    expect(await f.get()).toEqual(saved);
  }
  expect((await f.req(`/api/projects/${other.slug}/board`)).status).toBe(200);
  expect(
    (await (await f.req(`/api/projects/${other.slug}/board`)).json()).board,
  ).toEqual(defaults);
  expect((await f.set({ lanes: ["done"], issueIds: [] })).status).toBe(200);
  expect(await f.get()).toEqual({ lanes: ["done"], issueIds: [] });
  expect((await f.set(defaults)).status).toBe(200);
  expect(await f.get()).toEqual(defaults);
});

test("creation opt-in, default/all mode, unchanged issue shape and atomic rollback", async () => {
  const f = await fixture();
  for (const extra of [{}, { addToBoard: false }, { addToBoard: true }]) {
    expect((await f.create(extra)).status).toBe(200);
    expect(await f.get()).toEqual(defaults);
  }
  await f.set({ lanes: ["todo"], issueIds: [] });
  await f.create();
  await f.create({ addToBoard: false });
  expect((await f.get()).issueIds).toEqual([]);
  const issue = (await (await f.create({ addToBoard: true })).json()).issue;
  expect(issue).not.toHaveProperty("addToBoard");
  expect((await f.get()).issueIds).toEqual([issue.id]);
  await f.create({ addToBoard: false });
  expect((await f.get()).issueIds).toEqual([issue.id]);
  const count = () =>
    f.entry.app.db.query("SELECT COUNT(*) AS n FROM issues").get();
  const before = count();
  expect((await f.create({ addToBoard: "true" })).status).toBe(400);
  expect(
    (await f.create({ addToBoard: true, assigneeId: crypto.randomUUID() }))
      .status,
  ).toBe(400);
  expect(count()).toEqual(before);
  f.entry.app.db.exec(
    "CREATE TRIGGER reject_board BEFORE UPDATE ON project_boards BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  expect((await f.create({ addToBoard: true })).status).not.toBe(200);
  expect(count()).toEqual(before);
  expect((await f.get()).issueIds).toEqual([issue.id]);
});

test("v1 database migration preserves existing records and is repeatable", async () => {
  const f = await fixture();
  await f.create();
  // Reconstruct the pre-board schema, leaving populated v1 records untouched.
  f.entry.app.db.exec(
    "DROP TABLE project_boards; DELETE FROM migrations WHERE version=2;",
  );
  const snapshot = () =>
    ["users", "projects", "issues", "sessions"].map((table) =>
      f.entry.app.db.query(`SELECT * FROM ${table}`).all(),
    );
  const before = snapshot();
  for (let i = 0; i < 2; i++) {
    f.entry.app.close();
    f.entry.app = createApp({ dataDir: f.entry.dir });
    expect(snapshot()).toEqual(before);
    expect(await f.get()).toEqual(defaults);
    expect(
      f.entry.app.db
        .query("SELECT version FROM migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  }
});
