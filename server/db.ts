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
  return db;
}
