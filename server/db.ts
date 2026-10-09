import { Database } from "bun:sqlite";
import { appendIssueLabels, extractIssueLabels } from "../shared/labels";
import { extractMentionUserIds } from "../shared/mentions";
import { deriveIssueTitle, prependLegacyTitle } from "../shared/issue-content";

/** Called inside the content write transaction; historical unknown IDs are ignored. */
export function syncIssueTaggedUsers(db: Database, issueId: string) {
  const bodies = db.query("SELECT body FROM issues WHERE id=? UNION ALL SELECT body FROM comments WHERE issueId=?").all(issueId, issueId) as { body: string }[];
  const ids = new Set(bodies.flatMap(({ body }) => extractMentionUserIds(body)));
  db.query("DELETE FROM issue_tagged_users WHERE issueId=?").run(issueId);
  for (const userId of ids)
    db.query("INSERT INTO issue_tagged_users (issueId,userId) SELECT ?,id FROM users WHERE id=?").run(issueId, userId);
}

export function openDatabase(path: string, targetVersion: 10 | 11 = 11) {
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)",
  );
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=1").get())
      return;
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, role TEXT NOT NULL, createdAt TEXT NOT NULL, password TEXT);
      CREATE TABLE identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(issuer,subject));
      CREATE TABLE sessions (hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE oidc_flows (hash TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE issues (id TEXT PRIMARY KEY, number INTEGER NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, labels TEXT NOT NULL, assigneeId TEXT REFERENCES users(id), authorId TEXT NOT NULL REFERENCES users(id), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId,number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, issueId TEXT NOT NULL REFERENCES issues(id), authorId TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE INDEX issues_project ON issues(projectId);
      CREATE INDEX comments_issue ON comments(issueId);
      CREATE INDEX sessions_expiry ON sessions(expires);
      INSERT INTO migrations VALUES (1);
    `);
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=2").get())
      return;
    db.exec(`
      CREATE TABLE project_boards (
        projectId TEXT PRIMARY KEY REFERENCES projects(id),
        lanes TEXT NOT NULL,
        issueIds TEXT NOT NULL
      );
      INSERT INTO migrations VALUES (2);
    `);
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=3").get())
      return;
    const rows = db.query("SELECT id,title,body FROM issues").all() as {
      id: string;
      title: string;
      body: string;
    }[];
    for (const row of rows) {
      const body = prependLegacyTitle(row.title, row.body);
      db.query("UPDATE issues SET title=?,body=? WHERE id=?").run(
        deriveIssueTitle(body),
        body,
        row.id,
      );
    }
    db.query("INSERT INTO migrations VALUES (3)").run();
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=4").get())
      return;
    // Keep legacy selections and issue status/priority as archive, never active state.
    db.exec(`
      ALTER TABLE project_boards RENAME TO legacy_project_boards;
      CREATE TABLE project_boards (
        projectId TEXT PRIMARY KEY REFERENCES projects(id), lanes TEXT NOT NULL
      );
      CREATE UNIQUE INDEX issues_project_id ON issues(projectId,id);
      CREATE TABLE board_issues (
        projectId TEXT NOT NULL REFERENCES projects(id),
        issueId TEXT NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('todo','in_progress','done')),
        PRIMARY KEY(projectId,issueId),
        FOREIGN KEY(projectId,issueId) REFERENCES issues(projectId,id) ON DELETE CASCADE
      );
    `);
    const lanes = ["todo", "in_progress", "done"];
    const projects = db.query("SELECT id FROM projects").all() as {
      id: string;
    }[];
    for (const project of projects) {
      const old = db
        .query(
          "SELECT lanes,issueIds FROM legacy_project_boards WHERE projectId=?",
        )
        .get(project.id) as { lanes: string; issueIds: string } | null;
      const visible = old
        ? (JSON.parse(old.lanes) as string[]).map((l) =>
            l === "backlog" ? "todo" : l,
          )
        : lanes;
      const normalized = lanes.filter((l) => visible.includes(l));
      db.query("INSERT INTO project_boards VALUES (?,?)").run(
        project.id,
        JSON.stringify(normalized.length ? normalized : lanes),
      );
      const selected = old
        ? (JSON.parse(old.issueIds) as string[] | null)
        : null;
      const issues = db
        .query("SELECT CAST(id AS TEXT) AS id,status FROM issues WHERE projectId=? ORDER BY number")
        .all(project.id) as { id: string; status: string }[];
      for (const issue of issues) {
        if (
          selected !== null
            ? !selected.includes(issue.id)
            : !lanes.includes(issue.status)
        )
          continue;
        const lane = lanes.includes(issue.status) ? issue.status : "todo";
        db.query("INSERT INTO board_issues VALUES (?,?,?)").run(
          project.id,
          issue.id,
          lane,
        );
      }
    }
    db.query("INSERT INTO migrations VALUES (4)").run();
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=5").get())
      return;
    // Add definitions without changing visibility or existing placements. Rebuild
    // only the membership table to remove the old default-only lane CHECK.
    db.exec(`
      ALTER TABLE project_boards ADD COLUMN customLanes TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE board_issues_custom (
        projectId TEXT NOT NULL REFERENCES projects(id),
        issueId TEXT NOT NULL,
        lane TEXT NOT NULL,
        PRIMARY KEY(projectId,issueId),
        FOREIGN KEY(projectId,issueId) REFERENCES issues(projectId,id) ON DELETE CASCADE
      );
      INSERT INTO board_issues_custom SELECT projectId,issueId,lane FROM board_issues;
      DROP TABLE board_issues;
      ALTER TABLE board_issues_custom RENAME TO board_issues;
      INSERT INTO migrations VALUES (5);
    `);
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=6").get())
      return;
    // Additive lifecycle columns: NULL keeps every existing issue open and every
    // project active. Each column is added only when missing, so replaying this
    // version over a schema that already has them is safe.
    const additions = [
      ["issues", "closedAt", "TEXT"],
      ["issues", "closedById", "TEXT REFERENCES users(id)"],
      ["projects", "archivedAt", "TEXT"],
      ["projects", "archivedById", "TEXT REFERENCES users(id)"],
    ] as const;
    for (const [table, column, definition] of additions) {
      const columns = db.query(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      if (!columns.some((c) => c.name === column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    db.query("INSERT INTO migrations VALUES (6)").run();
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=7").get()) return;
    db.exec(`CREATE TABLE IF NOT EXISTS issue_tagged_users (
      issueId TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY(issueId,userId)
    );`);
    for (const { id } of db.query("SELECT id FROM issues").all() as { id: string }[])
      syncIssueTaggedUsers(db, id);
    db.query("INSERT INTO migrations VALUES (7)").run();
  }).immediate();
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=8").get()) return;
    const rows = db.query("SELECT id,title,body,labels FROM issues").all() as { id: string; title: string; body: string; labels: string }[];
    for (const row of rows) {
      // Migration does not truncate historical text or enforce new-write limits.
      const body = appendIssueLabels(row.body, row.title, JSON.parse(row.labels));
      db.query("UPDATE issues SET body=?,labels=? WHERE id=?").run(body, JSON.stringify(extractIssueLabels(body)), row.id);
      syncIssueTaggedUsers(db, row.id);
    }
    db.query("INSERT INTO migrations VALUES (8)").run();
  }).immediate();
  // SQLite cannot drop NOT NULL in place. Disable FK actions *outside* the
  // transaction so replacing the parent cannot cascade-delete child rows.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      if (db.query("SELECT version FROM migrations WHERE version=9").get()) return;
      const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='issues'").get() as { sql: string };
      const objects = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name='issues' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
      // Preserve the original table definition (including legacy columns and
      // constraints) and every explicit index/trigger instead of enumerating them.
      const definition = sql.replace(/^CREATE TABLE\s+(?:"issues"|issues)/i, 'CREATE TABLE issues_nullable')
        .replace(/\bprojectId\s+TEXT\s+NOT NULL\b/i, 'projectId TEXT');
      if (definition === sql) throw new Error("Unexpected issues table definition");
      db.exec(definition);
      const columns = db.query("PRAGMA table_xinfo(issues)").all() as { name: string; hidden: number }[];
      const names = columns.filter((c) => !c.hidden).map((c) => `"${c.name.replaceAll('"', '""')}"`).join(',');
      db.exec(`INSERT INTO issues_nullable (${names}) SELECT ${names} FROM issues;
        DROP TABLE issues;
        ALTER TABLE issues_nullable RENAME TO issues;`);
      for (const object of objects) db.exec(object.sql);
      // SQLite's ordinary composite UNIQUE permits repeated NULL values.
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS issues_unlinked_number ON issues(number) WHERE projectId IS NULL");
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Foreign key violation during issues migration");
      db.query("INSERT INTO migrations VALUES (9)").run();
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON");
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=10").get()) return;
    db.exec("ALTER TABLE board_issues ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    // Issue numbers are unique within a project, so using them as initial
    // positions preserves each old lane's ascending-number subsequence.
    db.exec(`UPDATE board_issues SET position=(SELECT number FROM issues WHERE id=board_issues.issueId);
      CREATE INDEX board_issues_order ON board_issues(projectId,lane,position);
      INSERT INTO migrations VALUES (10);`);
  }).immediate();
  if (targetVersion < 11) return db; // Historical fixtures may stop before the ID migration.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      if (db.query("SELECT version FROM migrations WHERE version=11").get()) return;
      const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='issues'").get() as { sql: string };
      const objects = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name='issues' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
      const definition = sql.replace(/^CREATE TABLE\s+(?:"issues"|issues)/i, 'CREATE TABLE issues_sequential')
        .replace(/\bid\s+TEXT\s+PRIMARY KEY\b/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT');
      if (!/id INTEGER PRIMARY KEY AUTOINCREMENT/i.test(definition)) throw new Error("Unexpected legacy issues schema");
      // Only needed while translating child relationships, never for URL lookup.
      db.exec(`CREATE TEMP TABLE issue_id_migration (
        legacyId TEXT PRIMARY KEY,
        issueId INTEGER NOT NULL
      );`);
      const rows = db.query("SELECT id FROM issues ORDER BY createdAt,rowid").all() as { id: string }[];
      const columns = db.query("PRAGMA table_xinfo(issues)").all() as { name: string; hidden: number }[];
      const names = columns.filter((c) => !c.hidden).map((c) => c.name);
      const quoted = names.map((name) => `"${name.replaceAll('"', '""')}"`).join(',');
      db.exec(definition);
      const selection = names.map((name) => name === 'id' || name === 'number' ? '?' : `"${name.replaceAll('"', '""')}"`).join(',');
      const copy = db.query(`INSERT INTO issues_sequential (${quoted}) SELECT ${selection} FROM issues WHERE id=?`);
      for (const [index, row] of rows.entries()) {
        const newId = index + 1;
        copy.run(newId, newId, row.id);
        db.query("INSERT INTO issue_id_migration VALUES (?,?)").run(row.id, newId);
      }
      // Child columns retain TEXT affinity deliberately: API IDs remain strings.
      // A single lookup update avoids collisions with any old decimal identifiers.
      for (const table of ['comments', 'board_issues', 'issue_tagged_users'])
        db.exec(`UPDATE ${table} SET issueId=CAST((SELECT issueId FROM issue_id_migration WHERE legacyId=${table}.issueId) AS TEXT)`);
      // legacy_project_boards is a historical archive, including its UUID selections.
      // Keep it byte-for-byte, along with historical prose; old URLs are unsupported.
      db.exec("DROP TABLE issue_id_migration; DROP TABLE issues; ALTER TABLE issues_sequential RENAME TO issues;");
      for (const object of objects) db.exec(object.sql);
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Foreign key violation during sequential issue migration");
      db.query("INSERT INTO migrations VALUES (11)").run();
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
