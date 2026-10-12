import type { Project } from "../../shared/types";

/** Pins follow personal order; other active projects follow their most recent issue update. */
export function projectNavigation(projects: Project[], pinnedIds: string[]) {
  const active = projects.filter((project) => !project.archivedAt);
  const byId = new Map(active.map((project) => [project.id, project]));
  const pinnedSet = new Set(pinnedIds);
  return {
    pinned: pinnedIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
    others: active.filter((project) => !pinnedSet.has(project.id)).sort((a, b) =>
      (b.lastIssueUpdatedAt ?? b.createdAt).localeCompare(a.lastIssueUpdatedAt ?? a.createdAt)
      || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}
