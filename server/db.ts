import { Database } from "bun:sqlite";
import { deriveIssueTitle, prependLegacyTitle } from "../shared/issue-content";

export function openDatabase(path: string) {
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
        .query("SELECT id,status FROM issues WHERE projectId=? ORDER BY number")
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
  return db;
}
