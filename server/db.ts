import { Database } from "bun:sqlite";
import { appendIssueLabels, extractIssueLabels } from "../shared/labels";
import { isLabel } from "../shared/hashtag-matches";
import { extractMentionUserIds } from "../shared/mentions";
import { deriveIssueTitle, prependLegacyTitle } from "../shared/issue-content";
import { retainAttachmentReferences } from "./attachments";

/** Called inside the content write transaction; historical unknown IDs are ignored. */
export function syncIssueTaggedUsers(db: Database, issueId: string) {
  const bodies = db.query("SELECT body FROM issues WHERE id=? UNION ALL SELECT body FROM comments WHERE issueId=?").all(issueId, issueId) as { body: string }[];
  const ids = new Set(bodies.flatMap(({ body }) => extractMentionUserIds(body)));
  db.query("DELETE FROM issue_tagged_users WHERE issueId=?").run(issueId);
  for (const userId of ids)
    db.query("INSERT INTO issue_tagged_users (issueId,userId) SELECT ?,id FROM users WHERE id=?").run(issueId, userId);
}

export interface MigrationWorkspaceOptions {
  workspaceName?: string;
  workspaceSlug?: string;
}

/** Validate before opening SQLite (or creating any application data files). */
export function migrationWorkspaceOptions(options: MigrationWorkspaceOptions = {}) {
  const workspaceName = options.workspaceName === undefined ? "Default" : options.workspaceName.trim();
  const workspaceSlug = options.workspaceSlug ?? "default";
  if (!workspaceName || workspaceName.length > 100)
    throw new Error("MIGRATION_WORKSPACE_NAME must contain 1 to 100 characters after trimming");
  if (workspaceSlug.length > 70 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspaceSlug))
    throw new Error("MIGRATION_WORKSPACE_SLUG must be 1 to 70 lowercase letters/digits with single hyphen separators");
  return { workspaceName, workspaceSlug };
}

export function openDatabase(path: string, targetVersion: 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 = 23, options: MigrationWorkspaceOptions = {}) {
  const migrationWorkspace = migrationWorkspaceOptions(options);
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
      const body = appendIssueLabels(row.body, row.title, (JSON.parse(row.labels) as string[]).filter(isLabel));
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
  if (targetVersion < 12) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=12").get()) return;
    // Additive only: do not invent events for existing content, or reset history.
    db.exec(`
      CREATE TABLE IF NOT EXISTS issue_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issueId TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        actorId TEXT NOT NULL REFERENCES users(id),
        createdAt TEXT NOT NULL,
        action TEXT NOT NULL,
        changes TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_history_page ON issue_history(issueId,id DESC);
      CREATE TABLE IF NOT EXISTS favorite_projects (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY(userId,projectId)
      );
      INSERT INTO migrations VALUES (12);
    `);
  }).immediate();
  if (targetVersion < 13) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=13").get()) return;
    // Labels are a derived index. Drop unsupported tag syntax without rewriting
    // historical prose, timestamps or history, or converting invalid tag names.
    const rows = db.query("SELECT id,body FROM issues").all() as { id: number; body: string }[];
    for (const row of rows)
      db.query("UPDATE issues SET labels=? WHERE id=?").run(JSON.stringify(extractIssueLabels(row.body)), row.id);
    db.query("INSERT INTO migrations VALUES (13)").run();
  }).immediate();
  if (targetVersion < 14) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=14").get()) return;
    db.exec(`
      ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private'));
      ALTER TABLE projects ADD COLUMN ownerId TEXT REFERENCES users(id);
      UPDATE projects SET ownerId=(SELECT id FROM users WHERE role='admin' ORDER BY createdAt,id LIMIT 1);
      CREATE TABLE project_members (
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(projectId,userId)
      );
      ALTER TABLE attachments ADD COLUMN uploaderId TEXT REFERENCES users(id);
      CREATE TABLE issue_attachments (
        issueId INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        attachmentId TEXT NOT NULL REFERENCES attachments(id),
        PRIMARY KEY(issueId,attachmentId)
      );
      CREATE INDEX issue_attachments_attachment ON issue_attachments(attachmentId,issueId);
    `);
    // Existing files inherit the current access of issues, including retained
    // comment/body history. Unreferenced legacy files are administrator-only.
    for (const row of db.query("SELECT id,body FROM issues").all() as { id: number; body: string }[])
      retainAttachmentReferences(db, row.id, [row.body]);
    for (const row of db.query("SELECT issueId,body FROM comments").all() as { issueId: number; body: string }[])
      retainAttachmentReferences(db, row.issueId, [row.body]);
    for (const row of db.query("SELECT issueId,changes FROM issue_history").all() as { issueId: number; changes: string }[]) {
      const changes = JSON.parse(row.changes) as { field: string; before: string | null; after: string | null }[];
      retainAttachmentReferences(db, row.issueId, changes.filter((change) => ["body", "comment"].includes(change.field))
        .flatMap((change) => [change.before ?? "", change.after ?? ""]));
    }
    db.query("INSERT INTO migrations VALUES (14)").run();
  }).immediate();
  if (targetVersion < 15) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=15").get()) return;
    // Keep the favorites table as the single source of truth for old clients.
    // Initialize each user's pins in the same project-ID order the legacy API used.
    db.exec(`ALTER TABLE favorite_projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      WITH ordered AS (
        SELECT userId,projectId,ROW_NUMBER() OVER (PARTITION BY userId ORDER BY projectId)-1 AS position
        FROM favorite_projects
      )
      UPDATE favorite_projects SET position=(SELECT position FROM ordered
        WHERE ordered.userId=favorite_projects.userId AND ordered.projectId=favorite_projects.projectId);
      CREATE INDEX favorite_projects_order ON favorite_projects(userId,position,projectId);
      CREATE INDEX issues_project_updated ON issues(projectId,updatedAt);
      INSERT INTO migrations VALUES (15);`);
  }).immediate();
  if (targetVersion < 16) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=16").get()) return;
    db.exec(`ALTER TABLE project_boards ADD COLUMN laneLabels TEXT NOT NULL DEFAULT '{}';
      INSERT INTO migrations VALUES (16);`);
  }).immediate();
  if (targetVersion < 17) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=17").get()) return;
    // Existing issues remain published, with their lifecycle and content intact.
    db.exec(`ALTER TABLE issues ADD COLUMN isDraft INTEGER NOT NULL DEFAULT 0
      CHECK(isDraft IN (0,1) AND (isDraft=0 OR closedAt IS NULL));
      INSERT INTO migrations VALUES (17);`);
  }).immediate();
  if (targetVersion < 18) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=18").get()) return;
    // Store only hashes of credentials. Existing sessions/content are untouched.
    db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        scopes TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('manual','cli')),
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        lastUsedAt TEXT,
        revokedAt TEXT
      );
      CREATE INDEX api_keys_user ON api_keys(userId,createdAt);
      CREATE TABLE device_authorizations (
        hash TEXT PRIMARY KEY,
        userCodeHash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires INTEGER NOT NULL,
        interval INTEGER NOT NULL DEFAULT 5,
        nextPollAt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
        userId TEXT REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX device_authorizations_expiry ON device_authorizations(expires);
      INSERT INTO migrations VALUES (18);
    `);
  }).immediate();
  if (targetVersion < 19) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=19").get()) return;
    db.exec(`
      CREATE TABLE plugin_settings (pluginId TEXT PRIMARY KEY, enabled INTEGER NOT NULL, value TEXT NOT NULL, secrets TEXT NOT NULL);
      CREATE TABLE plugin_state (pluginId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(pluginId,key));
      CREATE TABLE plugin_links (
        pluginId TEXT NOT NULL, issueId INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        externalId TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, status TEXT, tone TEXT NOT NULL,
        PRIMARY KEY(pluginId,issueId,externalId)
      );
      INSERT INTO migrations VALUES (19);
    `);
  }).immediate();
  if (targetVersion < 20) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=20").get()) return;
    db.exec(`
      CREATE TABLE issue_relationships (
        childId INTEGER PRIMARY KEY REFERENCES issues(id),
        parentId INTEGER NOT NULL REFERENCES issues(id),
        CHECK (childId != parentId)
      );
      CREATE INDEX issue_relationships_parent ON issue_relationships(parentId,childId);
      INSERT INTO migrations VALUES (20);
    `);
  }).immediate();
  if (targetVersion < 21) return db;
  db.transaction(() => {
    if (db.query("SELECT version FROM migrations WHERE version=21").get()) return;
    db.exec(`
      ALTER TABLE issues ADD COLUMN closeReason TEXT CHECK(closeReason IN ('completed','not_planned','duplicate'));
      ALTER TABLE issues ADD COLUMN duplicateOfId INTEGER REFERENCES issues(id);
      UPDATE issues SET closeReason='completed' WHERE closedAt IS NOT NULL;
      INSERT INTO migrations VALUES (21);
    `);
  }).immediate();
  if (targetVersion < 22) return db;
  // Rebuild only the projects table to remove global slug uniqueness. FK actions
  // must be off outside the transaction, otherwise replacing it deletes children.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      if (db.query("SELECT version FROM migrations WHERE version=22").get()) return;
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          visibility TEXT NOT NULL CHECK(visibility IN ('public','hidden')),
          createdAt TEXT NOT NULL, nextIssueNumber INTEGER NOT NULL DEFAULT 1
        );
      `);
      // Names are bound values, never SQL interpolation. Configuration applies
      // only when version 22 first runs; reopening never renames a workspace.
      db.query(`INSERT INTO workspaces VALUES ('default',?,?,'public',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        (SELECT COALESCE(MAX(number),0)+1 FROM issues))`).run(migrationWorkspace.workspaceSlug, migrationWorkspace.workspaceName);
      db.exec(`
        CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK(id=1), allowUserWorkspaceCreation INTEGER NOT NULL CHECK(allowUserWorkspaceCreation IN (0,1)));
        INSERT INTO workspace_settings VALUES (1,1);
        CREATE TABLE workspace_members (
          workspaceId TEXT NOT NULL REFERENCES workspaces(id), userId TEXT NOT NULL REFERENCES users(id),
          role TEXT NOT NULL CHECK(role IN ('admin','member')),
          defaultAccess TEXT NOT NULL CHECK(defaultAccess IN ('none','read','full')),
          legacyAccess INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(workspaceId,userId)
        );
        INSERT INTO workspace_members SELECT 'default',id,role,'full',1 FROM users;
        -- Compatibility onboarding applies ONLY to the migrated public Default.
        -- Hidden Default and all other workspaces require explicit invitations.
        CREATE TRIGGER users_default_workspace AFTER INSERT ON users
        WHEN (NEW.role='admin' OR EXISTS(SELECT 1 FROM workspaces WHERE id='default' AND visibility='public'))
          AND NOT EXISTS(SELECT 1 FROM workspace_invitations WHERE workspaceId='default' AND email=NEW.email) BEGIN
          INSERT INTO workspace_members VALUES ('default',NEW.id,NEW.role,'full',1);
        END;
        CREATE TABLE workspace_project_access (
          workspaceId TEXT NOT NULL, userId TEXT NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id),
          access TEXT NOT NULL CHECK(access IN ('read','full')),
          FOREIGN KEY(workspaceId,userId) REFERENCES workspace_members(workspaceId,userId) ON DELETE CASCADE,
          PRIMARY KEY(workspaceId,userId,projectId)
        );
        CREATE TABLE verified_account_emails (userId TEXT PRIMARY KEY REFERENCES users(id), email TEXT NOT NULL COLLATE NOCASE);
        INSERT INTO verified_account_emails SELECT id,email FROM users WHERE password IS NOT NULL;
        CREATE TRIGGER local_account_email AFTER INSERT ON users WHEN NEW.password IS NOT NULL BEGIN
          INSERT INTO verified_account_emails VALUES (NEW.id,NEW.email);
        END;
        CREATE TABLE workspace_invitations (
          id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id),
          email TEXT NOT NULL COLLATE NOCASE, defaultAccess TEXT NOT NULL CHECK(defaultAccess IN ('none','read','full')),
          projectAccess TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(workspaceId,email)
        );
        ALTER TABLE projects ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
        ALTER TABLE issues ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
        ALTER TABLE attachments ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
        DROP INDEX IF EXISTS issues_unlinked_number;
        CREATE UNIQUE INDEX issues_workspace_number ON issues(workspaceId,number);
      `);
      const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='projects'").get() as { sql: string };
      const objects = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name='projects' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
      db.exec(sql.replace(/^CREATE TABLE\s+(?:"projects"|projects)/i, 'CREATE TABLE projects_workspace')
        .replace(/slug TEXT NOT NULL UNIQUE/i, 'slug TEXT NOT NULL'));
      db.exec(`INSERT INTO projects_workspace SELECT * FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_workspace RENAME TO projects;`);
      for (const object of objects) db.exec(object.sql);
      db.exec(`
        CREATE UNIQUE INDEX projects_workspace_slug ON projects(workspaceId,slug);
        CREATE TRIGGER issues_workspace_insert BEFORE INSERT ON issues WHEN NEW.projectId IS NOT NULL BEGIN
          SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.projectId AND workspaceId=NEW.workspaceId)
            THEN RAISE(ABORT,'Cross-workspace project') END;
        END;
        CREATE TRIGGER issues_workspace_update BEFORE UPDATE OF projectId,workspaceId ON issues BEGIN
          SELECT CASE WHEN NEW.workspaceId!=OLD.workspaceId OR (NEW.projectId IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM projects WHERE id=NEW.projectId AND workspaceId=NEW.workspaceId))
            THEN RAISE(ABORT,'Cross-workspace project') END;
        END;
        CREATE TRIGGER projects_workspace_immutable BEFORE UPDATE OF workspaceId ON projects WHEN NEW.workspaceId!=OLD.workspaceId BEGIN
          SELECT RAISE(ABORT,'Workspace is immutable');
        END;
        INSERT INTO migrations VALUES (22);
      `);
      if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Foreign key violation during workspace migration");
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON");
  if (targetVersion < 23) return db;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      if (db.query("SELECT version FROM migrations WHERE version=23").get()) return;
      // External triggers (notably users_default_workspace) reference the rebuilt
      // tables too. Suspend and restore all triggers transactionally so ALTER
      // TABLE never sees a dangling reference, and copying rows has no effects.
      const triggers = db.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      for (const table of ['workspace_members', 'workspace_project_access', 'workspace_invitations']) {
        const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string };
        const indexes = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type='index' AND sql IS NOT NULL").all(table) as { sql: string }[];
        const accessCheck = table === 'workspace_project_access'
          ? /CHECK\s*\(\s*access\s+IN\s*\('read','full'\)\s*\)/i
          : /CHECK\s*\(\s*defaultAccess\s+IN\s*\('none','read','full'\)\s*\)/i;
        if (!accessCheck.test(sql)) throw new Error(`Unexpected ${table} access constraint`);
        const definition = sql.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/i, `CREATE TABLE ${table}_access`)
          .replace(accessCheck, table === 'workspace_project_access'
            ? "CHECK(access IN ('read','create-issue','read+create-issue','full'))"
            : "CHECK(defaultAccess IN ('none','read','create-issue','read+create-issue','full'))");
        db.exec(definition);
        const columns = db.query(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
        const names = columns.filter((c) => !c.hidden).map((c) => `"${c.name.replaceAll('"', '""')}"`).join(',');
        db.exec(`INSERT INTO ${table}_access (${names}) SELECT ${names} FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${table}_access RENAME TO ${table};`);
        for (const index of indexes) db.exec(index.sql);
      }
      db.exec(`ALTER TABLE projects ADD COLUMN creatorId TEXT REFERENCES users(id);
        UPDATE projects SET creatorId=ownerId;`);
      for (const trigger of triggers) db.exec(trigger.sql);
      // IS NOT is NULL-safe: even an unknown historical creator stays immutable.
      db.exec(`CREATE TRIGGER projects_creator_immutable BEFORE UPDATE OF creatorId ON projects
        WHEN NEW.creatorId IS NOT OLD.creatorId BEGIN
          SELECT RAISE(ABORT,'Project creator is immutable');
        END;`);
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Foreign key violation during workspace access migration");
      db.query("INSERT INTO migrations VALUES (23)").run();
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
