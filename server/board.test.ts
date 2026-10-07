import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { LANES } from "../shared/types";

// Exact resources owned by this run; never clean by prefix.
const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const e of owned.splice(0)) {
    e.app.close();
    rmSync(e.dir, { recursive: true, force: true });
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
    req(`${path}/issues`, "POST", { body: "Issue", ...extra });
  const add = (issueIds: string[], lane = "todo") =>
    req(`${path}/board/issues`, "POST", { issueIds, lane });
  return { entry, req, project, path, get, set, create, add };
}
const defaults = { lanes: LANES.map((s) => s.value), customLanes: [], cards: [] };
const custom = (label = "Review") => ({ value: `custom_${crypto.randomUUID()}`, label });

test("custom lanes persist, isolate projects, merge additively and hide populated lanes reversibly", async () => {
  const f = await fixture();
  const review = custom();
  const testing = custom("Testing");
  expect((await f.set({ lanes: [review.value, "todo"], customLanes: [{ ...review, label: " Review " }] })).status).toBe(200);
  expect(await f.get()).toEqual({ lanes: [review.value, "todo"], customLanes: [review], cards: [] });
  const a = (await (await f.create()).json()).issue;
  const b = (await (await f.create()).json()).issue;
  expect((await f.add([a.id], review.value)).status).toBe(200);
  expect((await f.add([b.id])).status).toBe(200);
  const move = (lane: string) => f.req(`${f.path}/board/issues/${b.id}`, "PATCH", { lane });
  expect((await move(review.value)).status).toBe(200);
  expect((await f.set({ lanes: ["todo"], customLanes: [] })).status).toBe(200);
  const hidden = await f.get();
  expect(hidden.customLanes).toEqual([review]);
  expect(hidden.cards).toEqual([a, b].map((issue) => ({ issueId: issue.id, lane: review.value })));
  expect((await move(review.value)).status).toBe(400);
  const c = (await (await f.create()).json()).issue;
  expect((await f.add([c.id], review.value)).status).toBe(400);
  expect((await move(custom().value)).status).toBe(400);
  expect((await f.set({ lanes: [testing.value, review.value, "todo"], customLanes: [testing] })).status).toBe(200);
  expect((await f.get()).lanes).toEqual([testing.value, review.value, "todo"]);
  expect((await f.add([c.id], review.value)).status).toBe(200);
  const saved = await f.get();
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.get()).toEqual(saved);
  const other = (await (await f.req("/api/projects", "POST", { name: "Other" })).json()).project;
  const path = `/api/projects/${other.slug}`;
  expect((await (await f.req(`${path}/board`)).json()).board).toEqual(defaults);
  expect((await f.req(`${path}/board`, "PATCH", { lanes: [review.value] })).status).toBe(400);
  const foreign = (await (await f.req(`${path}/issues`, "POST", { body: "Foreign" })).json()).issue;
  expect((await f.req(`${path}/board/issues`, "POST", { issueIds: [foreign.id], lane: review.value })).status).toBe(400);
  // Labels and IDs belong to the project, not a global namespace.
  expect((await f.req(`${path}/board`, "PATCH", { lanes: [review.value], customLanes: [review] })).status).toBe(200);
  expect(await f.get()).toEqual(saved);
});

test("custom definition validation is atomic and bounds the cumulative collection", async () => {
  const f = await fixture();
  const review = custom();
  await f.set({ lanes: ["todo", review.value], customLanes: [review] });
  const before = await f.get();
  const duplicate = custom("Duplicate");
  for (const customLanes of [
    [{ ...review, label: "Renamed" }],
    [custom("review")], [custom(" Todo ")], [custom("in PROGRESS")], [custom("Done")],
    [duplicate, duplicate], [duplicate, custom(" duplicate ")],
    [custom("")], [custom("   ")], [custom("x".repeat(61))],
    [{ value: "custom_invalid", label: "Invalid" }],
    [{ value: "todo", label: "Invalid" }],
    [{ ...custom(), extra: true }],
    Array.from({ length: 31 }, (_, i) => custom(`Lane ${i}`)),
  ]) {
    expect((await f.set({ lanes: ["todo"], customLanes })).status).toBe(400);
    expect(await f.get()).toEqual(before);
  }
  expect((await f.set({ lanes: ["unknown"], customLanes: [custom("Never stored")] })).status).toBe(400);
  expect(await f.get()).toEqual(before);
  const rest = Array.from({ length: 29 }, (_, i) => custom(`Lane ${i}`));
  expect((await f.set({ lanes: ["todo"], customLanes: rest })).status).toBe(200);
  const full = await f.get();
  expect(full.customLanes).toHaveLength(30);
  expect((await f.set({ lanes: ["done"], customLanes: [custom("Overflow")] })).status).toBe(400);
  expect(await f.get()).toEqual(full);
  expect((await f.set({ lanes: [review.value], customLanes: full.customLanes })).status).toBe(200);
});

test("v4 migration retains default visibility and populated hidden lane placements", async () => {
  const f = await fixture();
  const issue = (await (await f.create()).json()).issue;
  await f.add([issue.id], "done");
  await f.set({ lanes: ["todo"] });
  const before = await f.get();
  f.entry.app.db.exec("ALTER TABLE project_boards DROP COLUMN customLanes; DELETE FROM migrations WHERE version=5;");
  for (let run = 0; run < 2; run++) {
    f.entry.app.close();
    f.entry.app = createApp({ dataDir: f.entry.dir });
    expect(await f.get()).toEqual(before);
    expect(f.entry.app.db.query("SELECT COUNT(*) AS n FROM migrations WHERE version=5").get()).toEqual({ n: 1 });
  }
});

test("explicit board defaults, auth/CSRF, member edits, submitted lane order and restart", async () => {
  const f = await fixture();
  const issue = (await (await f.create()).json()).issue;
  expect(await f.get()).toEqual(defaults);
  for (const [suffix, method, body] of [
    ["", "GET", undefined],
    ["", "PATCH", { lanes: ["todo"] }],
    ["/lanes/todo", "PATCH", { index: 1 }],
    ["/issues", "POST", { issueIds: [issue.id], lane: "todo" }],
    [`/issues/${issue.id}`, "PATCH", { lane: "done" }],
    [`/issues/${issue.id}`, "DELETE", undefined],
  ] as const) {
    expect(
      (await f.req(`${f.path}/board${suffix}`, method, body, false)).status,
    ).toBe(401);
    if (method !== "GET")
      expect(
        (
          await f.req(
            `${f.path}/board${suffix}`,
            method,
            body,
            true,
            "https://evil.example",
          )
        ).status,
      ).toBe(403);
    expect(
      (await f.req(`/api/projects/missing/board${suffix}`, method, body))
        .status,
    ).toBe(404);
  }
  const member = {
    name: "Member",
    email: "member@example.com",
    password: "long-password-123",
  };
  await f.req("/api/admin/users", "POST", member);
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
    body: JSON.stringify({ lanes: ["done", "todo"] }),
  });
  expect(response.status).toBe(200);
  expect((await f.add([issue.id])).status).toBe(200);
  const saved = {
    customLanes: [],
    lanes: ["done", "todo"],
    cards: [{ issueId: issue.id, lane: "todo" }],
  };
  expect(await f.get()).toEqual(saved);
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.get()).toEqual(saved);
});

test("lane moves reorder only visible lanes, against current state, atomically", async () => {
  const f = await fixture();
  const moveLane = (lane: string, body: unknown) =>
    f.req(`${f.path}/board/lanes/${lane}`, "PATCH", body);
  // A board without saved settings starts from the defaults.
  const first = await moveLane("done", { index: 0 });
  expect(first.status).toBe(200);
  expect((await first.json()).board.lanes).toEqual(["done", "todo", "in_progress"]);
  expect((await moveLane("done", { index: 0 })).status).toBe(200);
  expect((await f.get()).lanes).toEqual(["done", "todo", "in_progress"]);
  expect((await moveLane("done", { index: 1 })).status).toBe(200);
  expect((await f.get()).lanes).toEqual(["todo", "done", "in_progress"]);
  // Positions past the end place the lane last.
  expect((await moveLane("todo", { index: 99 })).status).toBe(200);
  expect((await f.get()).lanes).toEqual(["done", "in_progress", "todo"]);

  const review = custom();
  await f.set({ lanes: ["done", "in_progress", "todo", review.value], customLanes: [review] });
  const a = (await (await f.create()).json()).issue;
  const b = (await (await f.create()).json()).issue;
  await f.add([a.id], review.value);
  await f.add([b.id], "done");
  expect((await moveLane(review.value, { index: 0 })).status).toBe(200);
  const moved = await f.get();
  expect(moved).toEqual({
    lanes: [review.value, "done", "in_progress", "todo"],
    customLanes: [review],
    cards: [
      { issueId: a.id, lane: review.value },
      { issueId: b.id, lane: "done" },
    ],
  });
  const openCount = (await (await f.req(f.path)).json()).project.openCount;

  const other = (await (await f.req("/api/projects", "POST", { name: "Other" })).json()).project;
  for (const [lane, body, status] of [
    ["todo", {}, 400],
    ["todo", { index: -1 }, 400],
    ["todo", { index: 1.5 }, 400],
    ["todo", { index: "1" }, 400],
    ["todo", { index: null }, 400],
    ["todo", { index: 1, lanes: ["todo"] }, 400],
    ["backlog", { index: 0 }, 404],
    [custom().value, { index: 0 }, 404],
  ] as const) {
    expect((await moveLane(lane, body)).status).toBe(status);
    expect(await f.get()).toEqual(moved);
  }
  // Custom lanes belong to their project.
  expect((await f.req(`/api/projects/${other.slug}/board/lanes/${review.value}`, "PATCH", { index: 0 })).status).toBe(404);

  // A move applies to the latest lanes: it never restores a lane someone else hid.
  const expectHidden = async (lane: string) => {
    const before = await f.get();
    const response = await moveLane(lane, { index: 0 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Lane is hidden");
    expect(await f.get()).toEqual(before);
  };
  await f.set({ lanes: [review.value, "done", "todo"] });
  await expectHidden("in_progress");
  await f.set({ lanes: ["done", "todo"] });
  await expectHidden(review.value);
  expect((await moveLane("todo", { index: 0 })).status).toBe(200);
  const final = await f.get();
  expect(final).toEqual({ ...moved, lanes: ["todo", "done"] });
  expect((await (await f.req(f.path)).json()).project.openCount).toBe(openCount);
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.get()).toEqual(final);
  expect(await (await f.req(`/api/projects/${other.slug}/board`)).json()).toEqual({ board: defaults });
});

test("strict selection validation, atomic add, project isolation and database constraints", async () => {
  const f = await fixture();
  const a = (await (await f.create()).json()).issue;
  const b = (await (await f.create()).json()).issue;
  const other = (
    await (await f.req("/api/projects", "POST", { name: "Other" })).json()
  ).project;
  const foreign = (
    await (
      await f.req(`/api/projects/${other.slug}/issues`, "POST", {
        body: "Foreign",
      })
    ).json()
  ).issue;
  for (const invalid of [
    {},
    { lanes: [] },
    { lanes: ["todo", "todo"] },
    { lanes: ["backlog"] },
    { lanes: ["todo"], issueIds: [] },
    { lanes: ["todo"], cards: [] },
  ]) {
    expect((await f.set(invalid)).status).toBe(400);
    expect(await f.get()).toEqual(defaults);
  }
  for (const ids of [
    [],
    [a.id, a.id],
    ["bad"],
    [a.id, crypto.randomUUID()],
    [a.id, foreign.id],
  ]) {
    expect((await f.add(ids)).status).toBe(400);
    expect(await f.get()).toEqual(defaults);
  }
  expect(
    (
      await f.req(`${f.path}/board/issues`, "POST", {
        issueIds: [a.id],
        lane: "todo",
        extra: true,
      })
    ).status,
  ).toBe(400);
  expect((await f.add([a.id], "backlog")).status).toBe(400);
  await f.set({ lanes: ["todo"] });
  expect((await f.add([a.id], "done")).status).toBe(400);
  expect((await f.add([a.id])).status).toBe(200);
  expect((await f.add([b.id, a.id], "todo")).status).toBe(409);
  expect((await f.get()).cards).toEqual([{ issueId: a.id, lane: "todo" }]);
  const db = f.entry.app.db;
  expect(() =>
    db
      .query("INSERT INTO board_issues VALUES (?,?,?)")
      .run(f.project.id, foreign.id, "todo"),
  ).toThrow();
  // Arbitrary lanes are rejected by the API; the DB retains project/issue constraints.
  expect((await f.add([b.id], "backlog")).status).toBe(400);
  db.exec(
    "CREATE TRIGGER reject_board BEFORE INSERT ON board_issues BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  expect((await f.add([b.id])).status).toBe(409);
  expect((await f.get()).cards).toHaveLength(1);
});

test("lanes independent from issue edits; hidden cards retained; removing membership preserves issue/comments", async () => {
  const f = await fixture();
  const issue = (await (await f.create({ labels: ["bug"] })).json()).issue;
  expect(issue).not.toHaveProperty("status");
  expect(issue).not.toHaveProperty("priority");
  expect(issue).not.toHaveProperty("assigneeId");
  for (const extra of [
    { status: "todo" },
    { priority: "high" },
    { assigneeId: null },
    { addToBoard: false },
    { lane: "todo" },
  ])
    expect((await f.create(extra)).status).toBe(400);
  for (const extra of [
    { status: "todo" },
    { priority: "high" },
    { assigneeId: issue.authorId },
    { lane: "done" },
  ])
    expect(
      (await f.req(`/api/issues/${issue.id}`, "PATCH", extra)).status,
    ).toBe(400);
  await f.add([issue.id]);
  const cardPath = `${f.path}/board/issues/${issue.id}`;
  expect(
    (await f.req(cardPath, "PATCH", { lane: "done", body: "bad" })).status,
  ).toBe(400);
  expect((await f.req(cardPath, "PATCH", { lane: "done" })).status).toBe(200);
  await f.req(`/api/issues/${issue.id}`, "PATCH", {
    body: "Stale editor save",
    labels: ["new"],
  });
  expect((await f.get()).cards).toEqual([{ issueId: issue.id, lane: "done" }]);
  expect((await (await f.req(f.path)).json()).project.openCount).toBe(0);
  await f.set({ lanes: ["todo"] });
  expect((await f.get()).cards).toEqual([{ issueId: issue.id, lane: "done" }]);
  expect((await f.req(cardPath, "PATCH", { lane: "done" })).status).toBe(400);
  expect((await f.req(cardPath, "PATCH", { lane: "todo" })).status).toBe(200);
  expect((await (await f.req(f.path)).json()).project.openCount).toBe(1);
  await f.req(`/api/issues/${issue.id}/comments`, "POST", {
    body: "Keep comment",
  });
  const before = await (await f.req(`/api/issues/${issue.id}`)).json();
  expect((await f.req(cardPath, "DELETE")).status).toBe(200);
  expect(await (await f.req(`/api/issues/${issue.id}`)).json()).toEqual(before);
  expect((await f.req(cardPath, "DELETE")).status).toBe(404);
  expect((await f.req(cardPath, "PATCH", { lane: "todo" })).status).toBe(404);
  expect((await (await f.req(f.path)).json()).project.openCount).toBe(0);
  expect((await (await f.req(f.path)).json()).project.issueCount).toBe(1);
});

test("forward migration preserves explicit selection, translates backlog, excludes automatic backlog and is repeatable", async () => {
  const f = await fixture();
  const db = f.entry.app.db;
  const projects = [f.project];
  for (const name of ["Automatic", "No settings", "Empty"])
    projects.push(
      (await (await f.req("/api/projects", "POST", { name })).json()).project,
    );
  const ids: string[][] = [];
  for (const p of projects) {
    const projectIds = [];
    for (const status of ["backlog", "todo", "in_progress", "done"]) {
      const issue = (
        await (
          await f.req(`/api/projects/${p.slug}/issues`, "POST", {
            body: status,
          })
        ).json()
      ).issue;
      db.query("UPDATE issues SET status=?,priority='urgent' WHERE id=?").run(
        status,
        issue.id,
      );
      projectIds.push(issue.id);
      await f.req(`/api/issues/${issue.id}/comments`, "POST", {
        body: "preserve",
      });
    }
    ids.push(projectIds);
  }
  db.exec(
    "DROP TABLE board_issues; DROP INDEX issues_project_id; DROP TABLE project_boards; ALTER TABLE legacy_project_boards RENAME TO project_boards; DELETE FROM migrations WHERE version>=4;",
  );
  db.query("INSERT INTO project_boards VALUES (?,?,?)").run(
    projects[0].id,
    '["backlog","done"]',
    JSON.stringify([ids[0]![0], ids[0]![2]]),
  );
  db.query("INSERT INTO project_boards VALUES (?,?,?)").run(
    projects[1].id,
    '["backlog","todo","in_progress","done"]',
    "null",
  );
  db.query("INSERT INTO project_boards VALUES (?,?,?)").run(
    projects[3].id,
    "[]",
    "[]",
  );
  const snapshot = () =>
    ["users", "projects", "issues", "sessions", "comments"].map((t) =>
      f.entry.app.db.query(`SELECT * FROM ${t}`).all(),
    );
  const before = snapshot();
  for (let run = 0; run < 2; run++) {
    f.entry.app.close();
    f.entry.app = createApp({ dataDir: f.entry.dir });
    expect(snapshot()).toEqual(before);
    const boards = await Promise.all(
      projects.map(
        async (p) =>
          (await (await f.req(`/api/projects/${p.slug}/board`)).json()).board,
      ),
    );
    expect(boards[0]).toEqual({
      customLanes: [],
      lanes: ["todo", "done"],
      cards: [
        { issueId: ids[0]![0], lane: "todo" },
        { issueId: ids[0]![2], lane: "in_progress" },
      ],
    });
    for (const n of [1, 2])
      expect(boards[n]).toEqual({
        customLanes: [],
        lanes: defaults.lanes,
        cards: ids[n]!.slice(1).map((issueId, i) => ({
          issueId,
          lane: defaults.lanes[i],
        })),
      });
    expect(boards[3]).toEqual(defaults);
    expect(
      f.entry.app.db
        .query("SELECT COUNT(*) AS n FROM migrations WHERE version=4")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      f.entry.app.db
        .query("SELECT COUNT(*) AS n FROM legacy_project_boards")
        .get(),
    ).toEqual({ n: 3 });
  }
});
