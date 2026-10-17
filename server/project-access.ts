import type { Database } from "bun:sqlite";
import { HTTPException } from "hono/http-exception";
import type { Project, User, WorkspacePermissions } from "../shared/types";
import { canCreateIssues, canReadAllIssues } from "../shared/access";
type IssueAccessRow = { projectId: string | null; authorId: string | null; isDraft?: number | boolean; state?: string };

export const workspaceIdFor = (user: User) => user.workspaceId ?? "default";
// An explicit project grant replaces (rather than maximizes) default access.
// Legacy Default memberships retain private-project owner/share restrictions;
// editing their workspace permissions switches them to the explicit new model.
const memberProjectAccess = `COALESCE((SELECT pa.access FROM workspace_project_access pa
  WHERE pa.workspaceId=p.workspaceId AND pa.userId=wm.userId AND pa.projectId=p.id),
  CASE WHEN wm.legacyAccess=1 AND p.visibility='private' AND p.ownerId IS NOT wm.userId
    AND NOT EXISTS(SELECT 1 FROM project_members pm WHERE pm.projectId=p.id AND pm.userId=wm.userId)
    THEN 'none' ELSE wm.defaultAccess END)`;
export const visibleProjectSql = `(p.workspaceId=? AND (?='admin' OR EXISTS (
  SELECT 1 FROM workspace_members wm WHERE wm.workspaceId=p.workspaceId AND wm.userId=?
  AND (wm.role='admin' OR ${memberProjectAccess} != 'none')
)))`;
// Personal draft privacy deliberately has no system/workspace-admin exception.
const issueMemberAccess = `(CASE WHEN i.projectId IS NULL THEN wm.defaultAccess ELSE
  (SELECT ${memberProjectAccess} FROM projects p WHERE p.id=i.projectId AND p.workspaceId=i.workspaceId) END)`;
export const visibleIssueSql = `(i.workspaceId=? AND (i.isDraft=0 OR i.authorId=?) AND
  (?='admin' OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspaceId=i.workspaceId AND wm.userId=?
    AND (wm.role='admin' OR ${issueMemberAccess} IN ('read','read+create-issue','full')
      OR (i.authorId=? AND ${issueMemberAccess} != 'none')))))`;
export const accessParams = (user: User) => [workspaceIdFor(user), user.role, user.id] as const;
export const issueAccessParams = (user: User) => [workspaceIdFor(user), user.id, user.role, user.id, user.id] as const;

export function projectAccess(db: Database) {
  function level(projectId: string | null, user: User): WorkspacePermissions {
    const workspaceId = workspaceIdFor(user);
    if (projectId !== null && !db.query("SELECT 1 FROM projects WHERE id=? AND workspaceId=?").get(projectId, workspaceId)) return "none";
    if (user.role === "admin") return "full";
    const member = db.query("SELECT role,defaultAccess FROM workspace_members WHERE workspaceId=? AND userId=?")
      .get(workspaceId, user.id) as { role: string; defaultAccess: WorkspacePermissions } | null;
    if (!member) return "none";
    if (member.role === "admin") return "full";
    if (projectId === null) return member.defaultAccess;
    const result = db.query(`SELECT ${memberProjectAccess} AS access FROM projects p
      JOIN workspace_members wm ON wm.workspaceId=p.workspaceId AND wm.userId=? WHERE p.id=? AND p.workspaceId=?`)
      .get(user.id, projectId, workspaceId) as { access: WorkspacePermissions } | null;
    return result?.access ?? "none";
  }
  const canRead = (projectId: string | null, user: User) => level(projectId, user) !== "none";
  function requireRead(projectId: string | null, user: User, resource = "Project") {
    if (!canRead(projectId, user)) throw new HTTPException(404, { message: `${resource} not found` });
  }
  function requireWrite(projectId: string | null, user: User, resource = "Project") {
    requireRead(projectId, user, resource);
    if (level(projectId, user) !== "full") throw new HTTPException(403, { message: "Full permissions required" });
  }
  function canManageWorkspace(user: User) {
    return user.role === "admin" || !!db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId=? AND role='admin'")
      .get(workspaceIdFor(user), user.id);
  }
  const canReadIssue = (row: IssueAccessRow, user: User) => {
    if ((row.isDraft || row.state === 'draft') && row.authorId !== user.id) return false;
    const access = level(row.projectId, user);
    return access !== 'none' && (canReadAllIssues(access) || row.authorId === user.id);
  };
  const canWriteIssue = (row: IssueAccessRow, user: User) => canReadIssue(row, user)
    && (level(row.projectId, user) === 'full' || row.authorId === user.id);
  const requireIssueRead = (row: IssueAccessRow, user: User) => {
    if (!canReadIssue(row, user)) throw new HTTPException(404, { message: 'Issue not found' });
  };
  const requireIssueWrite = (row: IssueAccessRow, user: User) => {
    requireIssueRead(row, user);
    if (!canWriteIssue(row, user)) throw new HTTPException(403, { message: 'Issue edit permission required' });
  };
  const canManageLanes = (project: Omit<Project, 'sharedUserIds'>, user: User) =>
    project.creatorId === user.id && !project.archivedAt && level(project.id, user) === 'full';
  return {
    level, canRead, requireRead, requireWrite, canManageWorkspace,
    canReadIssue, canWriteIssue, requireIssueRead, requireIssueWrite, canManageLanes,
    requireCreate(projectId: string | null, user: User, resource = 'Project') {
      requireRead(projectId, user, resource);
      if (!canCreateIssues(level(projectId, user))) throw new HTTPException(403, { message: 'Create-issue permission required' });
    },
    requireManageLanes(project: Project, user: User) {
      requireRead(project.id, user);
      if (!canManageLanes(project, user)) throw new HTTPException(403, { message: 'Project creator with write permissions required' });
    },
    canWriteAny(user: User) {
      if (canCreateIssues(level(null, user))) return true;
      if ((db.query("SELECT id FROM projects WHERE workspaceId=? AND archivedAt IS NULL").all(workspaceIdFor(user)) as { id: string }[])
        .some((p) => canCreateIssues(level(p.id, user)))) return true;
      return (db.query(`SELECT i.projectId,i.authorId,i.isDraft FROM issues i LEFT JOIN projects p ON p.id=i.projectId
        WHERE i.workspaceId=? AND i.authorId=? AND p.archivedAt IS NULL`).all(workspaceIdFor(user), user.id) as IssueAccessRow[])
        .some((row) => canWriteIssue(row, user));
    },
    requireManage(project: Project, user: User) {
      requireWrite(project.id, user);
      if (!canManageWorkspace(user) && project.ownerId !== user.id)
        throw new HTTPException(403, { message: "Project owner or administrator required" });
    },
    serialize(project: Omit<Project, "sharedUserIds">, user: User): Project {
      const sharedUserIds = (db.query("SELECT userId FROM project_members WHERE projectId=? ORDER BY userId")
        .all(project.id) as { userId: string }[]).map((row) => row.userId);
      const workspace = db.query("SELECT slug FROM workspaces WHERE id=?").get(project.workspaceId) as { slug: string };
      const effective = level(project.id, user);
      return { ...project, sharedUserIds, workspaceSlug: workspace.slug, access: effective === "none" ? null : effective, canManageLanes: canManageLanes(project, user) };
    },
  };
}
