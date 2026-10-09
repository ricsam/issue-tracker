import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app";
import { openDatabase } from "./db";
import { mentionMarkdown } from "../shared/mentions";

const run = crypto.randomUUID();
const manifest = join(tmpdir(), `workspace-issues-${run}.json`);
const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), `workspace-issues-${run}-`));
  dirs.push(dir);
  writeFileSync(manifest, JSON.stringify({ run, dirs }));
  return dir;
};
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true }); rmSync(manifest); });

test("workspace creation, independent numbering, lifecycle, board rejection, auth and atomic cross-project bulk", async () => {
  const app = createApp({ dataDir: directory() });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => app.request(path, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const user = (await setup.json()).user;
    const project = (await (await req("/api/projects", "POST", { name: "Project" })).json()).project;
    const other = (await (await req("/api/projects", "POST", { name: "Other" })).json()).project;
    const create = async (input: unknown, path = "/api/issues") => {
      const response = await req(path, "POST", input);
      expect(response.status).toBe(200);
      return (await response.json()).issue;
    };
    const a = await create({ body: "Unlinked #first" });
    const b = await create({ body: "Unlinked", projectId: null });
    const c = await create({ body: "Linked", projectId: project.id });
    const d = await create({ title: "Legacy", body: "Body", labels: ["compatible"] }, `/api/projects/${project.slug}/issues`);
    const e = await create({ body: "Other", projectId: other.id });
    expect([a.projectId, b.projectId, c.projectId]).toEqual([null, null, project.id]);
    expect([a.number, b.number, c.number, d.number, e.number]).toEqual([1, 2, 1, 2, 1]);
    expect((await req("/api/issues", "POST", { body: "x", projectId: crypto.randomUUID() })).status).toBe(404);
    expect((await req("/api/issues", "POST", { body: "x", projectId: 1 })).status).toBe(400);
    expect((await req(`/api/issues/${a.id}`, "PATCH", { projectId: project.id })).status).toBe(400);
    expect((await req(`/api/projects/${project.slug}/board/issues`, "POST", { issueIds: [a.id], lane: "todo" })).status).toBe(400);
    expect((await req(`/api/issues/${a.id}/comments`, "POST", { body: mentionMarkdown(user) })).status).toBe(200);
    let detail = await (await req(`/api/issues/${a.id}`)).json();
    expect(detail.comments).toHaveLength(1);
    expect(detail.issue.taggedUserIds).toEqual([user.id]);
    expect((await req(`/api/comments/${detail.comments[0].id}`, "PATCH", { body: "Edited comment" })).status).toBe(200);
    detail = await (await req(`/api/issues/${a.id}`)).json();
    expect(detail.issue.taggedUserIds).toEqual([]);
    expect((await req(`/api/comments/${detail.comments[0].id}`, "DELETE")).status).toBe(200);
    for (const state of ["closed", "open"]) {
      const response = await req(`/api/issues/${a.id}`, "PATCH", { body: "Edited #second", state });
      expect(response.status).toBe(200);
      expect((await response.json()).issue.state).toBe(state);
    }
    const ids = [a.id, c.id, e.id];
    for (const [path, payload] of [
      ["/api/issues/tagged-users", { issueIds: ids, userIds: [user.id] }],
      ["/api/issues/labels", { issueIds: ids, labels: ["bulk"] }],
    ] as const) {
      expect((await req(path, "POST", payload, "")).status).toBe(401);
      expect((await req(path, "POST", payload, cookie, "https://evil.example")).status).toBe(403);
      const result = await req(path, "POST", payload);
      expect(result.status).toBe(200);
      expect((await result.json()).issues).toHaveLength(3);
    }
    expect((await req("/api/issues", "GET", undefined, "")).status).toBe(401);
    expect((await req("/api/issues", "POST", { body: "x" }, "")).status).toBe(401);
    expect((await req("/api/issues", "POST", { body: "x" }, cookie, "https://evil.example")).status).toBe(403);
    await req(`/api/projects/${project.slug}`, "PATCH", { archived: true });
    expect((await req("/api/issues", "POST", { body: "x", projectId: project.id })).status).toBe(409);
    expect((await (await req("/api/issues")).json()).issues).toHaveLength(5);
    const before = app.db.query("SELECT * FROM issues ORDER BY id").all();
    for (const target of [c.id, crypto.randomUUID()]) {
      const status = target === c.id ? 409 : 404;
      expect((await req("/api/issues/labels", "POST", { issueIds: [a.id, target], labels: ["rollback"] })).status).toBe(status);
      expect((await req("/api/issues/tagged-users", "POST", { issueIds: [b.id, target], userIds: [user.id] })).status).toBe(status);
      expect(app.db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(before);
    }
    expect((await req(`/api/issues/${b.id}`, "PATCH", { state: "closed" })).status).toBe(200);
  } finally { app.close(); }
});

test("v9 rebuild preserves populated v8 tables, constraints, indexes, triggers and children; reopening is idempotent", () => {
  const path = join(directory(), "migration.sqlite");
  let db = openDatabase(path);
  // Reconstruct the exact pre-v9 NOT NULL schema while retaining all v8 additions.
  const schema = (db.query("SELECT sql FROM sqlite_schema WHERE name='issues'").get() as { sql: string }).sql;
  const indexes = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name='issues' AND type='index' AND sql IS NOT NULL AND name!='issues_unlinked_number'").all() as { sql: string }[];
  db.exec("PRAGMA foreign_keys=OFF");
  db.transaction(() => {
    db.exec("DROP TABLE issues");
    db.exec(schema.replace(/projectId TEXT/, "projectId TEXT NOT NULL"));
    for (const { sql } of indexes) db.exec(sql);
    db.exec("DELETE FROM migrations WHERE version=9");
  }).immediate();
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO users VALUES ('u','User','user@example.com','admin','time',NULL);
    INSERT INTO projects VALUES ('p','project','Project','','time',NULL,NULL);
    INSERT INTO issues VALUES ('i',1,'p','Legacy title','Body','todo','high','[]','u','u','time','time','closed','u');
    INSERT INTO comments VALUES ('c','i','u','Comment','time','time');
    INSERT INTO issue_tagged_users VALUES ('i','u');
    INSERT INTO board_issues (projectId,issueId,lane) VALUES ('p','i','custom_lane');
    CREATE INDEX custom_issue_index ON issues(priority);
    CREATE TRIGGER preserve_trigger BEFORE UPDATE OF priority ON issues BEGIN SELECT RAISE(ABORT,'preserved'); END;`);
  const tables = ["issues", "comments", "issue_tagged_users", "board_issues"];
  const rows = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    db = openDatabase(path);
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(rows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT name FROM sqlite_schema WHERE name IN ('issues_project','issues_project_id','custom_issue_index','preserve_trigger')").all()).toHaveLength(4);
    expect(() => db.exec("UPDATE issues SET priority='low'")).toThrow();
    expect(() => db.exec("UPDATE issues SET projectId='missing'")).toThrow();
    db.close();
  }
  db = openDatabase(path);
  const insert = db.query("INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (?,1,?,'Title','Body','backlog','none','[]','u','time','time')");
  insert.run("unlinked", null);
  expect(() => insert.run("duplicate", null)).toThrow();
  expect(() => insert.run("duplicate-project", "p")).toThrow();
  expect(() => db.exec("INSERT INTO board_issues (projectId,issueId,lane) VALUES ('p','unlinked','todo')")).toThrow();
  expect(() => db.exec("DELETE FROM issues WHERE id='i'")).toThrow();
  db.close();
});

test("v9 foreign-key validation failure rolls back schema, data and migration marker", () => {
  const path = join(directory(), "rollback.sqlite");
  let db = openDatabase(path);
  db.exec("DELETE FROM migrations WHERE version=9; PRAGMA foreign_keys=OFF");
  db.exec("INSERT INTO comments VALUES ('broken','missing','missing','Body','time','time')");
  const schema = db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
  db.close();
  expect(() => openDatabase(path)).toThrow("Foreign key violation during issues migration");
  db = new Database(path);
  expect(db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  expect(db.query("SELECT version FROM migrations WHERE version=9").get()).toBeNull();
  expect(db.query("SELECT id FROM comments").all()).toEqual([{ id: "broken" }]);
  db.close();
});
