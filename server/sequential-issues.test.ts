import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db";
import { createApp } from "./app";

const run = crypto.randomUUID();
const dirs: string[] = [];
const manifest = join(tmpdir(), `sequential-issues-${run}.json`);
function directory() {
  const dir = mkdtempSync(join(tmpdir(), `sequential-issues-${run}-`));
  dirs.push(dir);
  writeFileSync(manifest, JSON.stringify({ run, dirs }));
  return dir;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true }); rmSync(manifest); });

function legacyFixture() {
  const dir = directory(), path = join(dir, "app.sqlite");
  const db = openDatabase(path, 10);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  db.exec(`INSERT INTO users VALUES ('u','User','user@example.com','admin','time',NULL);
    INSERT INTO projects VALUES ('p','p','P','','time',NULL,NULL),('q','q','Q','','time','archived','u');
    INSERT INTO project_boards VALUES ('p','["todo"]','[]'),('q','["done"]','[]');
    CREATE INDEX custom_issue_index ON issues(priority);
    CREATE TRIGGER retained_trigger BEFORE UPDATE OF priority ON issues BEGIN SELECT RAISE(ABORT,'preserved'); END;`);
  // Insert out of chronological order, with overlapping project-local numbers.
  for (const [index, projectId, createdAt] of [[0, 'p', '2020-02'], [1, 'q', '2020-01'], [2, null, '2020-02']] as const) {
    db.query("INSERT INTO issues (id,number,projectId,title,body,status,priority,labels,assigneeId,authorId,createdAt,updatedAt,closedAt,closedById) VALUES (?,1,?,'Title',?,'todo','high','[\"tag\"]','u','u',?,'updated',?,?)")
      .run(ids[index]!, projectId, `#tag [old](/issues/${ids[0]})`, createdAt, index === 1 ? 'closed' : null, index === 1 ? 'u' : null);
    db.query("INSERT INTO comments VALUES (?,?, 'u',?,'created','updated')").run(`c${index}`, ids[index]!, `Keep #tag and /issues/${ids[0]}`);
    db.query("INSERT INTO issue_tagged_users VALUES (?,'u')").run(ids[index]!);
  }
  db.query("INSERT INTO board_issues VALUES ('p',?,'todo',17),('q',?,'done',4)").run(ids[0]!, ids[1]!);
  db.query("INSERT INTO legacy_project_boards VALUES ('p','[\"backlog\"]',?)").run(JSON.stringify([ids[0]]));
  db.close();
  return { dir, path, ids };
}

test("v11 atomically renumbers globally, preserves children, archives, lifecycle and indexes without UUID aliases; repeatable", async () => {
  const { dir, path, ids } = legacyFixture();
  const beforeDb = new Database(path);
  const oldRows = beforeDb.query("SELECT * FROM issues ORDER BY createdAt,rowid").all() as any[];
  const archive = beforeDb.query("SELECT * FROM legacy_project_boards").all();
  const comments = beforeDb.query("SELECT * FROM comments ORDER BY id").all() as any[];
  beforeDb.close();
  const mapping = new Map([[ids[1], '1'], [ids[0], '2'], [ids[2], '3']]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase(path);
    expect(db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(oldRows.map((row, index) => ({ ...row, id: index + 1, number: index + 1 })));
    expect(db.query("SELECT * FROM comments ORDER BY id").all()).toEqual(comments.map((row) => ({ ...row, issueId: mapping.get(row.issueId) })));
    expect(db.query("SELECT * FROM legacy_project_boards").all()).toEqual(archive);
    expect(db.query("SELECT * FROM issue_tagged_users ORDER BY issueId").all()).toEqual(['1','2','3'].map((issueId) => ({ issueId, userId: 'u' })));
    expect(db.query("SELECT * FROM board_issues ORDER BY projectId").all()).toEqual([
      { projectId: 'p', issueId: '2', lane: 'todo', position: 17 }, { projectId: 'q', issueId: '1', lane: 'done', position: 4 },
    ]);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='issue_id_aliases'").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_temp_schema WHERE name='issue_id_migration'").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT name FROM sqlite_schema WHERE name IN ('issues_project','issues_project_id','issues_unlinked_number','custom_issue_index','retained_trigger','comments_issue','board_issues_order')").all()).toHaveLength(7);
    expect((db.query("SELECT sql FROM sqlite_schema WHERE name='issues'").get() as any).sql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(() => db.exec("UPDATE issues SET priority='low'")).toThrow();
    db.close();
  }
  const app = createApp({ dataDir: dir });
  try {
    // Authenticate via an ordinary persisted session without changing migrated users.
    const token = 'test-session';
    const hash = new Bun.CryptoHasher('sha256').update(token).digest('hex');
    app.db.query("INSERT INTO sessions VALUES (?,'u',?)").run(hash, Date.now() + 60000);
    const headers = { Cookie: `session=${token}` };
    for (const oldId of ids)
      expect((await app.request(`/api/issues/${oldId}`, { headers })).status).toBe(404);
    const response = await app.request('/api/issues/2', { headers });
    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(detail.issue.id).toBe('2');
    expect(detail.issue.number).toBe(2);
    expect(detail.comments[0].issueId).toBe('2');
    expect(detail.issue.body).toBe(oldRows[1].body);
  } finally { app.close(); }
});

test("v11 failed FK validation rolls back all data, schema and migration marker", () => {
  const { path } = legacyFixture();
  let db = new Database(path);
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO comments VALUES ('broken','absent','u','Body','time','time')");
  const schema = db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
  const rows = db.query("SELECT * FROM issues ORDER BY id").all();
  db.close();
  expect(() => openDatabase(path)).toThrow();
  db = new Database(path);
  expect(db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  expect(db.query("SELECT * FROM issues ORDER BY id").all()).toEqual(rows);
  expect(db.query("SELECT version FROM migrations WHERE version=11").get()).toBeNull();
  db.close();
});

test("global IDs survive restart and highest/all deletion; API strings, references and strict bulk/board inputs", async () => {
  const dir = directory();
  let app = createApp({ dataDir: dir }), cookie = '';
  const req = (path: string, method = 'GET', body?: unknown, auth = cookie) => app.request(path, {
    method, headers: { Cookie: auth, Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const setup = await req('/api/auth/setup', 'POST', { name: 'Admin', email: 'admin@example.com', password: 'long-password-123' });
    cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await setup.json()).user;
    const project = (await (await req('/api/projects', 'POST', { name: 'Project' })).json()).project;
    const create = async (projectId: string | null = null, body = 'Reference title') => {
      const response = await req('/api/issues', 'POST', { projectId, body });
      expect(response.status).toBe(200);
      const issue = (await response.json()).issue;
      expect(issue.id).toBe(String(issue.number));
      return issue;
    };
    const a = await create(project.id), b = await create(), c = await create(project.id);
    expect([a.id,b.id,c.id]).toEqual(['1','2','3']);
    app.db.query('DELETE FROM issues WHERE id=?').run(c.id);
    app.close(); app = createApp({ dataDir: dir });
    expect((await create()).id).toBe('4');
    app.db.exec('DELETE FROM issues');
    app.close(); app = createApp({ dataDir: dir });
    const live = await create(project.id);
    expect(live.id).toBe('5');
    const boardPath = `/api/projects/${project.slug}/board/issues`;
    expect((await (await req(boardPath, 'PUT', { issueIds: [live.id], lane: 'todo' })).json()).board.cards).toEqual([{ issueId: '5', lane: 'todo' }]);
    expect((await req(`${boardPath}/reorder`, 'POST', { issueIds: [live.id], lane: 'done', beforeIssueId: null })).status).toBe(200);
    for (const invalid of [crypto.randomUUID(), '05', '0', '-5', '5.0', '5e0', 5, '9007199254740992']) {
      for (const [path, method, payload] of [
        ['/api/issues/labels', 'POST', { labels: ['tag'] }],
        ['/api/issues/tagged-users', 'POST', { userIds: [user.id] }],
        [boardPath, 'PUT', { lane: 'todo' }],
        [boardPath, 'POST', { lane: 'todo' }],
        [`${boardPath}/reorder`, 'POST', { lane: 'todo', beforeIssueId: null }],
      ] as const) expect((await req(path, method, { ...payload, issueIds: [invalid] })).status).toBe(400);
    }
    const comment = (await (await req(`/api/issues/${live.id}/comments`, 'POST', { body: 'Comment' })).json()).comment;
    expect(comment.issueId).toBe(live.id);
    expect((await (await req(`/api/comments/${comment.id}`, 'PATCH', { body: 'Edit' })).json()).comment.issueId).toBe(live.id);
    expect((await req('/api/issues/labels', 'POST', { issueIds: [live.id], labels: ['tag'] })).status).toBe(200);
    expect((await req('/api/issues/tagged-users', 'POST', { issueIds: [live.id], userIds: [user.id] })).status).toBe(200);
    await req(`/api/issues/${live.id}`, 'PATCH', { state: 'closed' });
    await req(`/api/projects/${project.slug}`, 'PATCH', { archived: true });
    for (const q of ['!5', '5', 'reference']) {
      const response = await req(`/api/issues/references?q=${q}`);
      expect(response.status).toBe(200);
      expect((await response.json()).issues).toEqual([{ id: '5', number: 5, title: 'Reference title', state: 'closed' }]);
    }
    expect((await req('/api/issues/references', 'GET', undefined, '')).status).toBe(401);
    expect((await (await req('/api/issues/references?q=%23tag')).json()).issues).toEqual([]);
    expect((await req(`/api/issues/references?q=${'x'.repeat(301)}`)).status).toBe(400);
    for (let i = 0; i < 25; i++) await create();
    expect((await (await req('/api/issues/references?q=Reference')).json()).issues).toHaveLength(20);
    const listing = await (await req('/api/issues')).json();
    expect(listing.issues.every((i: any) => typeof i.id === 'string' && i.number === Number(i.id))).toBe(true);
    expect(listing.boards[project.id].cards[0].issueId).toBe('5');
  } finally { app.close(); }
});
