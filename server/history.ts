import type { Database } from "bun:sqlite";
import { LANES, type BoardLane, type IssueHistoryEntry } from "../shared/types";

type Snapshot = { body: string; state: string; project: string | null; boardLane: string | null; projectId: string | null; lane: string | null };
export function issueSnapshot(db: Database, issueId: string): Snapshot | null {
  const row = db.query(`SELECT i.body,i.closedAt,i.projectId,p.name AS project,b.lane,pb.customLanes
    FROM issues i LEFT JOIN projects p ON p.id=i.projectId
    LEFT JOIN board_issues b ON b.issueId=i.id
    LEFT JOIN project_boards pb ON pb.projectId=i.projectId WHERE i.id=?`).get(issueId) as
    { body: string; closedAt: string | null; projectId: string | null; project: string | null; lane: string | null; customLanes: string | null } | null;
  if (!row) return null;
  const definitions: BoardLane[] = [...LANES, ...JSON.parse(row.customLanes ?? "[]")];
  return { body: row.body, state: row.closedAt ? "closed" : "open", project: row.project,
    projectId: row.projectId, lane: row.lane,
    boardLane: row.lane === null ? null : definitions.find((lane) => lane.value === row.lane)?.label ?? row.lane };
}
export function recordHistory(db: Database, issueId: string, actorId: string,
  action: IssueHistoryEntry["action"], changes: IssueHistoryEntry["changes"]) {
  if (!changes.length) return;
  db.query("INSERT INTO issue_history (issueId,actorId,createdAt,action,changes) VALUES (?,?,?,?,?)")
    .run(issueId, actorId, new Date().toISOString(), action, JSON.stringify(changes));
}
export function recordIssueChange(db: Database, issueId: string, actorId: string, before: Snapshot | null) {
  const after = issueSnapshot(db, issueId);
  if (!after) throw new Error("History target missing");
  const changes: IssueHistoryEntry["changes"] = [];
  for (const field of ["body", "state", "project", "boardLane"] as const) {
    // Compare identities too: two distinct projects may have the same name.
    const identityChanged = field === "project" ? before?.projectId !== after.projectId
      : field === "boardLane" ? before?.lane !== after.lane : false;
    if ((before?.[field] ?? null) !== after[field] || (before && identityChanged))
      changes.push({ field, before: before?.[field] ?? null, after: after[field] });
  }
  recordHistory(db, issueId, actorId, before ? "updated" : "created", changes);
}
/** Snapshot and write under one immediate transaction; thrown mutations leave no events. */
export function withIssueHistory<T>(db: Database, actorId: string, issueIds: string[], mutate: () => T): T {
  return db.transaction(() => {
    const snapshots = new Map([...new Set(issueIds)].map((id) => [id, issueSnapshot(db, id)]));
    const result = mutate();
    for (const [id, before] of snapshots) recordIssueChange(db, id, actorId, before);
    return result;
  }).immediate();
}
export function readHistory(db: Database, issueId: string, before: number | null, limit: number) {
  const rows = db.query(`SELECT * FROM issue_history WHERE issueId=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`)
    .all(issueId, before, before, limit + 1) as (Omit<IssueHistoryEntry, "changes"> & { changes: string })[];
  return { history: rows.slice(0, limit).map((row) => ({ ...row, issueId: String(row.issueId), changes: JSON.parse(row.changes) as IssueHistoryEntry["changes"] })), hasMore: rows.length > limit };
}
