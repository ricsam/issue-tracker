import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "./db";
import { workspaceService } from "./workspaces";
import type { AppEnv } from "./api-access";
import type { User } from "../shared/types";

function seed(db: ReturnType<typeof openDatabase>) {
  db.exec(`INSERT INTO users (id,name,email,role,createdAt,password) VALUES
    ('owner','Owner','owner@example.com','admin','2026-01-01','hash'),
    ('member','Member','member@example.com','member','2026-01-01','hash');
    INSERT INTO projects (id,slug,name,description,createdAt,ownerId) VALUES
    ('project','project','Project','','2026-01-01','owner'),
    ('unknown','unknown','Unknown','','2026-01-01',NULL);
    INSERT INTO workspace_project_access VALUES ('default','member','project','read');
    INSERT INTO workspace_invitations VALUES ('invite','default','invite@example.com','none','[]','2026-01-01');`);
}

test("v23 preserves access rows, indexes, external triggers and foreign keys across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-access-migration-"));
  const path = join(dir, "db.sqlite");
  let db = openDatabase(path, 22);
  try {
    seed(db);
    db.exec(`CREATE INDEX custom_member_access ON workspace_members(defaultAccess);
      CREATE TABLE access_audit (value TEXT);
      CREATE TRIGGER custom_access_update AFTER UPDATE ON workspace_members BEGIN
        INSERT INTO access_audit VALUES (NEW.defaultAccess);
      END;`);
    const before = ["workspace_members", "workspace_project_access", "workspace_invitations"].map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const triggers = db.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 23 });
    expect(["workspace_members", "workspace_project_access", "workspace_invitations"].map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(db.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name!='projects_creator_immutable' ORDER BY name").all()).toEqual(triggers);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='custom_member_access'").get()).not.toBeNull();
    expect(db.query("SELECT * FROM access_audit").all()).toEqual([]);
    for (const access of ["none", "read", "create-issue", "read+create-issue", "full"]) {
      db.query("UPDATE workspace_members SET defaultAccess=? WHERE userId='member'").run(access);
      db.query("UPDATE workspace_invitations SET defaultAccess=?").run(access);
      if (access !== "none") db.query("UPDATE workspace_project_access SET access=?").run(access);
    }
    expect(() => db.exec("UPDATE workspace_project_access SET access='none'")).toThrow();
    for (const [table, column] of [["workspace_members", "defaultAccess"], ["workspace_invitations", "defaultAccess"], ["workspace_project_access", "access"]])
      expect(() => db.exec(`UPDATE ${table} SET ${column}='invalid'`)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM access_audit").get()).toEqual({ count: 5 });
    expect(() => db.exec("INSERT INTO workspace_project_access VALUES ('default','absent','project','read')")).toThrow();
    db.exec("DELETE FROM workspace_members WHERE userId='member'");
    expect(db.query("SELECT * FROM workspace_project_access").all()).toEqual([]);
    // The external onboarding trigger must still target the original table name.
    db.exec("INSERT INTO users (id,name,email,role,createdAt) VALUES ('later','Later','later@example.com','member','2026-01-02')");
    expect(db.query("SELECT defaultAccess FROM workspace_members WHERE userId='later'").get()).toEqual({ defaultAccess: "full" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec(`UPDATE workspace_invitations SET defaultAccess='create-issue';
      UPDATE workspace_members SET defaultAccess='read+create-issue' WHERE userId='later';
      INSERT INTO workspace_project_access VALUES ('default','later','project','create-issue');`);
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT defaultAccess FROM workspace_invitations").get()).toEqual({ defaultAccess: "create-issue" });
    expect(db.query("SELECT defaultAccess FROM workspace_members WHERE userId='later'").get()).toEqual({ defaultAccess: "read+create-issue" });
    expect(db.query("SELECT access FROM workspace_project_access WHERE userId='later'").get()).toEqual({ access: "create-issue" });
    expect(db.query("SELECT COUNT(*) AS count FROM access_audit").get()).toEqual({ count: 6 });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("creator is backfilled once and immutable including null and owner transfers", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-creator-migration-"));
  const path = join(dir, "db.sqlite");
  let db = openDatabase(path, 22);
  try {
    seed(db);
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT creatorId FROM projects WHERE id='project'").get()).toEqual({ creatorId: "owner" });
    expect(db.query("SELECT creatorId FROM projects WHERE id='unknown'").get()).toEqual({ creatorId: null });
    db.exec("UPDATE projects SET ownerId='member',creatorId=creatorId WHERE id='project'");
    expect(() => db.exec("UPDATE projects SET creatorId='member' WHERE id='project'")).toThrow("Project creator is immutable");
    expect(() => db.exec("UPDATE projects SET creatorId=NULL WHERE id='project'")).toThrow();
    expect(() => db.exec("UPDATE projects SET creatorId='owner' WHERE id='unknown'")).toThrow();
    expect(() => db.exec("UPDATE projects SET workspaceId='elsewhere' WHERE id='project'")).toThrow("Workspace is immutable");
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT ownerId,creatorId FROM projects WHERE id='project'").get()).toEqual({ ownerId: "member", creatorId: "owner" });
    expect(() => db.exec("UPDATE projects SET ownerId='owner',creatorId='member' WHERE id='project'")).toThrow();
    expect(db.query("SELECT ownerId FROM projects WHERE id='project'").get()).toEqual({ ownerId: "member" });
    expect(() => db.exec("INSERT INTO projects (id,slug,name,description,createdAt,creatorId) VALUES ('new','new','New','','now','missing')")).toThrow();
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed v23 migration rolls back table rebuilds and trigger changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-access-rollback-"));
  const path = join(dir, "db.sqlite");
  let db = openDatabase(path, 22);
  try {
    seed(db);
    // Simulate a pre-existing FK violation: the final check must abort all DDL.
    db.exec("PRAGMA foreign_keys=OFF; UPDATE projects SET ownerId='missing' WHERE id='project'");
    const schema = db.query("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    db.close();
    expect(() => openDatabase(path)).toThrow("Foreign key violation during workspace access migration");
    db = new Database(path, { strict: true });
    expect(db.query("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()).toEqual(schema);
    expect(db.query("SELECT MAX(version) AS version FROM migrations").get()).toEqual({ version: 22 });
    db.exec("UPDATE projects SET ownerId='owner' WHERE id='project'");
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT creatorId FROM projects WHERE id='project'").get()).toEqual({ creatorId: "owner" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("workspace API accepts new defaults and overrides but never a none override", async () => {
  const db = openDatabase(":memory:");
  try {
    seed(db);
    const app = new Hono<AppEnv>();
    const user = db.query("SELECT id,name,email,role FROM users WHERE id='owner'").get() as User;
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.onError((_error, c) => c.json({ error: "Invalid input" }, 400));
    workspaceService(db).register(app);
    for (const access of ["create-issue", "read+create-issue"]) {
      const result = await app.request("/api/workspaces/default/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com", defaultAccess: access, projectAccess: [{ projectId: "project", access }] }) });
      expect(result.status).toBe(200);
      expect((await result.json()).invitation).toMatchObject({ defaultAccess: access, projectAccess: [{ projectId: "project", access }] });
      const patched = await app.request("/api/workspaces/default/members/member", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultAccess: access, projectAccess: [{ projectId: "project", access }], convertLegacyAccess: true }) });
      expect(patched.status).toBe(200);
      expect((await patched.json()).member).toMatchObject({ defaultAccess: access, projectAccess: [{ projectId: "project", access }] });
    }
    const result = await app.request("/api/workspaces/default/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com", defaultAccess: "none", projectAccess: [{ projectId: "project", access: "none" }] }) });
    expect(result.status).toBe(400);
  } finally { db.close(); }
});
