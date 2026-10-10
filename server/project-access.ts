import type { Database } from "bun:sqlite";
import { HTTPException } from "hono/http-exception";
import type { Project, User } from "../shared/types";

/** Keep discovery and direct authorization on the same predicate. Alias projects as p. */
export const visibleProjectSql = `(?='admin' OR p.visibility='public' OR p.ownerId=? OR EXISTS (
  SELECT 1 FROM project_members pm WHERE pm.projectId=p.id AND pm.userId=?
))`;
export const visibleIssueSql = `(i.projectId IS NULL OR EXISTS (
  SELECT 1 FROM projects p WHERE p.id=i.projectId AND ${visibleProjectSql}
))`;
export const accessParams = (user: User) => [user.role, user.id, user.id] as const;

export function projectAccess(db: Database) {
  const canRead = (projectId: string | null, user: User) => projectId === null || !!db.query(
    `SELECT 1 FROM projects p WHERE p.id=? AND ${visibleProjectSql}`,
  ).get(projectId, ...accessParams(user));
  return {
    canRead,
    requireRead(projectId: string | null, user: User, resource = "Project") {
      if (!canRead(projectId, user)) throw new HTTPException(404, { message: `${resource} not found` });
    },
    requireManage(project: Project, user: User) {
      if (user.role !== "admin" && project.ownerId !== user.id)
        throw new HTTPException(403, { message: "Project owner or administrator required" });
    },
    serialize(project: Omit<Project, "sharedUserIds">): Project {
      const sharedUserIds = (db.query("SELECT userId FROM project_members WHERE projectId=? ORDER BY userId")
        .all(project.id) as { userId: string }[]).map((row) => row.userId);
      return { ...project, sharedUserIds };
    },
  };
}
