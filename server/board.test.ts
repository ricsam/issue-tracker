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
const defaults = { lanes: LANES.map((s) => s.value), cards: [] };

test("explicit board defaults, auth/CSRF, member edits, canonical lanes and restart", async () => {
  const f = await fixture();
  const issue = (await (await f.create()).json()).issue;
  expect(await f.get()).toEqual(defaults);
  for (const [suffix, method, body] of [
    ["", "GET", undefined],
    ["", "PATCH", { lanes: ["todo"] }],
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
    lanes: ["todo", "done"],
    cards: [{ issueId: issue.id, lane: "todo" }],
  };
  expect(await f.get()).toEqual(saved);
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await f.get()).toEqual(saved);
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
  expect(() =>
    db
      .query("INSERT INTO board_issues VALUES (?,?,?)")
      .run(f.project.id, b.id, "backlog"),
  ).toThrow();
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
  expect(issue.assigneeId).toBeNull();
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
    assigneeId: issue.authorId,
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
    "DROP TABLE board_issues; DROP INDEX issues_project_id; DROP TABLE project_boards; ALTER TABLE legacy_project_boards RENAME TO project_boards; DELETE FROM migrations WHERE version=4;",
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
      lanes: ["todo", "done"],
      cards: [
        { issueId: ids[0]![0], lane: "todo" },
        { issueId: ids[0]![2], lane: "in_progress" },
      ],
    });
    for (const n of [1, 2])
      expect(boards[n]).toEqual({
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
