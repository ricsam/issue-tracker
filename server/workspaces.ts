import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./api-access";
import type { User, Workspace, WorkspaceMember, WorkspaceInvitation, WorkspaceProjectAccess } from "../shared/types";

export const workspaceSlugField = z.string().min(1).max(70).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const name = z.string().trim().min(1).max(100);
const visibility = z.enum(["public", "hidden"]);
const defaultAccess = z.enum(["none", "read", "full"]);
const projectAccess = z.array(z.object({ projectId: z.string().min(1).max(100), access: z.enum(["read", "full"]) }).strict()).max(1000)
  .refine((rows) => new Set(rows.map((row) => row.projectId)).size === rows.length);
const permissions = z.object({ defaultAccess, projectAccess: projectAccess.default([]) });
type WorkspaceRow = Pick<Workspace, "id" | "slug" | "name" | "visibility">;
type InvitationRow = Omit<WorkspaceInvitation, "projectAccess"> & { workspaceId: string; projectAccess: string };
const notFound = (): never => { throw new HTTPException(404, { message: "Workspace not found" }); };
const forbidden = (): never => { throw new HTTPException(403, { message: "Workspace administrator required" }); };

export function workspaceService(db: Database) {
  function serialize(row: WorkspaceRow, user: User): Workspace {
    const membership = db.query("SELECT role,defaultAccess FROM workspace_members WHERE workspaceId=? AND userId=?")
      .get(row.id, user.id) as Pick<Workspace, "role" | "defaultAccess"> | null;
    return { id: row.id, slug: row.slug, name: row.name, visibility: row.visibility,
      role: membership?.role ?? null, defaultAccess: membership?.defaultAccess ?? "none",
      canManage: user.role === "admin" || membership?.role === "admin" };
  }
  function get(slug: string, user: User, management = false): Workspace {
    const row = db.query("SELECT * FROM workspaces WHERE slug=?").get(slug) as WorkspaceRow | null;
    if (!row) return notFound();
    const workspace = serialize(row, user);
    if (workspace.visibility === "hidden" && workspace.role === null && !workspace.canManage) return notFound();
    if (management && !workspace.canManage) forbidden();
    return workspace;
  }
  function grants(workspaceId: string, userId: string): WorkspaceProjectAccess[] {
    return db.query("SELECT projectId,access FROM workspace_project_access WHERE workspaceId=? AND userId=? ORDER BY projectId")
      .all(workspaceId, userId) as WorkspaceProjectAccess[];
  }
  function member(workspaceId: string, userId: string): WorkspaceMember {
    const row = db.query(`SELECT u.id,u.id AS userId,u.name,u.email,m.role,m.defaultAccess,m.legacyAccess FROM workspace_members m
      JOIN users u ON u.id=m.userId WHERE m.workspaceId=? AND m.userId=?`).get(workspaceId, userId) as (Omit<WorkspaceMember, "projectAccess" | "legacyAccess"> & { legacyAccess: number }) | null;
    if (!row) throw new HTTPException(404, { message: "Member not found" });
    return { ...row, legacyAccess: !!row.legacyAccess, projectAccess: grants(workspaceId, userId) };
  }
  function validateGrants(workspaceId: string, rows: WorkspaceProjectAccess[]) {
    for (const row of rows) if (!db.query("SELECT 1 FROM projects WHERE id=? AND workspaceId=?").get(row.projectId, workspaceId))
      throw new HTTPException(400, { message: "Unknown workspace project" });
  }
  function saveGrants(workspaceId: string, userId: string, rows: WorkspaceProjectAccess[]) {
    validateGrants(workspaceId, rows);
    db.query("DELETE FROM workspace_project_access WHERE workspaceId=? AND userId=?").run(workspaceId, userId);
    for (const row of rows) db.query("INSERT INTO workspace_project_access VALUES (?,?,?,?)").run(workspaceId, userId, row.projectId, row.access);
  }
  function invitation(row: InvitationRow): WorkspaceInvitation {
    return { id: row.id, email: row.email, defaultAccess: row.defaultAccess, createdAt: row.createdAt, projectAccess: JSON.parse(row.projectAccess) };
  }
  // Invitations are applied only against server-verified current profile email.
  // OIDC must refresh this assertion after verified login; local accounts are
  // created by the system administrator, not by a self-asserted signup form.
  function acceptInvitations(user: User) {
    if (!db.query("SELECT 1 FROM verified_account_emails WHERE userId=? AND email=?").get(user.id, user.email)) return;
    db.transaction(() => {
      const rows = db.query("SELECT * FROM workspace_invitations WHERE email=?").all(user.email) as InvitationRow[];
      for (const row of rows) {
        // Existing membership changes use PATCH, never a surprise invitation escalation.
        const inserted = db.query("INSERT OR IGNORE INTO workspace_members (workspaceId,userId,role,defaultAccess) VALUES (?,?,'member',?)")
          .run(row.workspaceId, user.id, row.defaultAccess);
        if (inserted.changes) saveGrants(row.workspaceId, user.id, JSON.parse(row.projectAccess));
        db.query("DELETE FROM workspace_invitations WHERE id=?").run(row.id);
      }
    }).immediate();
  }
  function settings() {
    const row = db.query("SELECT allowUserWorkspaceCreation FROM workspace_settings WHERE id=1").get() as { allowUserWorkspaceCreation: number };
    return { allowUserWorkspaceCreation: !!row.allowUserWorkspaceCreation };
  }
  function list(user: User, all = false) {
    return (db.query("SELECT * FROM workspaces ORDER BY createdAt,id").all() as WorkspaceRow[]).map((row) => serialize(row, user))
      .filter((row) => all || row.visibility === "public" || row.role !== null || row.canManage);
  }
  function retainAdministrator(workspaceId: string, userId: string, nextRole?: string) {
    const old = db.query("SELECT role FROM workspace_members WHERE workspaceId=? AND userId=?").get(workspaceId, userId) as { role: string } | null;
    if (!old) throw new HTTPException(404, { message: "Member not found" });
    if (old.role === "admin" && nextRole !== "admin" && !db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId!=? AND role='admin'").get(workspaceId, userId))
      throw new HTTPException(409, { message: "Workspace must retain an administrator" });
  }
  function register(app: Hono<AppEnv>) {
    app.get("/api/workspaces", (c) => c.json({ workspaces: list(c.get("user")), ...settings() }));
    app.post("/api/workspaces", async (c) => {
      if (c.get("user").role !== "admin" && !settings().allowUserWorkspaceCreation) throw new HTTPException(403, { message: "Workspace creation requires a system administrator" });
      const input = z.object({ name, slug: workspaceSlugField, visibility }).strict().parse(await c.req.json().catch(() => null));
      db.transaction(() => {
        const id = crypto.randomUUID();
        db.query("INSERT INTO workspaces (id,slug,name,visibility,createdAt) VALUES (?,?,?,?,?)").run(id, input.slug, input.name, input.visibility, new Date().toISOString());
        db.query("INSERT INTO workspace_members (workspaceId,userId,role,defaultAccess) VALUES (?,?,'admin','full')").run(id, c.get("user").id);
      }).immediate();
      return c.json({ workspace: get(input.slug, c.get("user")) });
    });
    app.get("/api/workspaces/:slug", (c) => c.json({ workspace: get(c.req.param("slug"), c.get("user")) }));
    app.patch("/api/workspaces/:slug", async (c) => {
      const input = z.object({ name: name.optional(), visibility: visibility.optional() }).strict().refine((v) => Object.keys(v).length > 0).parse(await c.req.json().catch(() => null));
      const w = get(c.req.param("slug"), c.get("user"), true);
      db.query("UPDATE workspaces SET name=?,visibility=? WHERE id=?").run(input.name ?? w.name, input.visibility ?? w.visibility, w.id);
      return c.json({ workspace: get(w.slug, c.get("user")) });
    });
    app.get("/api/workspaces/:slug/members", (c) => {
      const w = get(c.req.param("slug"), c.get("user"), true);
      const members = (db.query("SELECT userId FROM workspace_members WHERE workspaceId=? ORDER BY userId").all(w.id) as { userId: string }[])
        .map((row) => member(w.id, row.userId));
      const invitations = (db.query("SELECT * FROM workspace_invitations WHERE workspaceId=? ORDER BY createdAt,id").all(w.id) as InvitationRow[]).map(invitation);
      return c.json({ members, invitations });
    });
    app.post("/api/workspaces/:slug/invitations", async (c) => {
      const w = get(c.req.param("slug"), c.get("user"), true);
      const input = permissions.extend({ email: z.email().max(254).transform((v) => v.toLowerCase()) }).strict().parse(await c.req.json().catch(() => null));
      const result = db.transaction(() => {
        validateGrants(w.id, input.projectAccess);
        if (db.query("SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.userId WHERE m.workspaceId=? AND u.email=?").get(w.id, input.email))
          throw new HTTPException(409, { message: "User is already a member" });
        const row = db.query(`INSERT INTO workspace_invitations (id,workspaceId,email,defaultAccess,projectAccess,createdAt) VALUES (?,?,?,?,?,?)
          ON CONFLICT(workspaceId,email) DO UPDATE SET defaultAccess=excluded.defaultAccess,projectAccess=excluded.projectAccess RETURNING *`)
          .get(crypto.randomUUID(), w.id, input.email, input.defaultAccess, JSON.stringify(input.projectAccess), new Date().toISOString()) as InvitationRow;
        return invitation(row);
      }).immediate();
      return c.json({ invitation: result });
    });
    app.patch("/api/workspaces/:slug/members/:userId", async (c) => {
      const input = permissions.extend({ role: z.enum(["admin", "member"]).optional(), convertLegacyAccess: z.boolean().optional() }).strict().parse(await c.req.json().catch(() => null));
      const w = get(c.req.param("slug"), c.get("user"), true), userId = c.req.param("userId");
      db.transaction(() => {
        const previous = member(w.id, userId);
        retainAdministrator(w.id, userId, input.role ?? previous.role);
        const normalize = (rows: WorkspaceProjectAccess[]) => JSON.stringify([...rows].sort((a, b) => a.projectId.localeCompare(b.projectId)));
        const permissionsChanged = input.defaultAccess !== previous.defaultAccess || normalize(input.projectAccess) !== normalize(previous.projectAccess);
        if (previous.legacyAccess && permissionsChanged && !input.convertLegacyAccess)
          throw new HTTPException(409, { message: "Changing legacy permissions replaces private-project protections. Confirm with convertLegacyAccess: true." });
        saveGrants(w.id, userId, input.projectAccess);
        db.query("UPDATE workspace_members SET role=?,defaultAccess=?,legacyAccess=? WHERE workspaceId=? AND userId=?")
          .run(input.role ?? previous.role, input.defaultAccess, Number(previous.legacyAccess && !input.convertLegacyAccess), w.id, userId);
      }).immediate();
      return c.json({ member: member(w.id, userId) });
    });
    app.delete("/api/workspaces/:slug/members/:userId", (c) => {
      const w = get(c.req.param("slug"), c.get("user"), true), userId = c.req.param("userId");
      db.transaction(() => {
        retainAdministrator(w.id, userId);
        db.query("DELETE FROM workspace_members WHERE workspaceId=? AND userId=?").run(w.id, userId);
      }).immediate();
      return c.json({ ok: true });
    });
    app.delete("/api/workspaces/:slug/invitations/:id", (c) => {
      const w = get(c.req.param("slug"), c.get("user"), true);
      if (!db.query("DELETE FROM workspace_invitations WHERE workspaceId=? AND id=?").run(w.id, c.req.param("id")).changes)
        throw new HTTPException(404, { message: "Invitation not found" });
      return c.json({ ok: true });
    });
    const requireAdmin = (user: User) => { if (user.role !== "admin") throw new HTTPException(403, { message: "System administrator required" }); };
    app.get("/api/admin/workspace-settings", (c) => { requireAdmin(c.get("user")); return c.json(settings()); });
    app.patch("/api/admin/workspace-settings", async (c) => {
      requireAdmin(c.get("user"));
      const input = z.object({ allowUserWorkspaceCreation: z.boolean() }).strict().parse(await c.req.json().catch(() => null));
      db.query("UPDATE workspace_settings SET allowUserWorkspaceCreation=? WHERE id=1").run(Number(input.allowUserWorkspaceCreation));
      return c.json(settings());
    });
    app.get("/api/admin/workspaces", (c) => { requireAdmin(c.get("user")); return c.json({ workspaces: list(c.get("user"), true) }); });
  }
  return { get, register, acceptInvitations };
}
