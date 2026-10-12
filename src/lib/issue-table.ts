import type { Issue, Project, User } from "../../shared/types";
import type { IssueBoardLane } from "./issue-board-lanes";
import { defaultIssueFilters, isActiveIssueFilter, matchesIssueFilters, type IssueFilterGroup } from "./issue-filters";
export { issueDateKey } from "./issue-filters";

export type IssueColumn = "number" | "title" | "labels" | "tagged" | "creator" | "created" | "project" | "lane" | "state";
export interface IssueTableState {
  sort: IssueColumn;
  direction: "ascending" | "descending";
  filters: IssueFilterGroup;
}
export const initialIssueTableState: IssueTableState = {
  sort: "number",
  direction: "ascending",
  filters: defaultIssueFilters,
};

export function hasColumnFilters(state: IssueTableState) {
  return state.filters.conditions.some(isActiveIssueFilter);
}

export function issueTableRows(issues: Issue[], users: User[], state: IssueTableState, projects: Project[] = [], boardLanes: ReadonlyMap<string, IssueBoardLane> = new Map()) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const projectName = (issue: Issue) => issue.projectId ? projectNames.get(issue.projectId) || issue.projectId : "No project";
  const names = new Map(users.map((user) => [user.id, user.name]));
  const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const taggedNames = (issue: Issue) => issue.taggedUserIds.map((id) => names.get(id) || id).sort(compareText).join(", ");
  return issues.filter((issue) => matchesIssueFilters(issue, state.filters, { users, lane: boardLanes.get(issue.id)?.value })).sort((a, b) => {
    let comparison: number;
    switch (state.sort) {
      case "state": comparison = compareText(a.state, b.state); break;
      case "lane": comparison = compareText(boardLanes.get(a.id)?.label ?? "Not on board", boardLanes.get(b.id)?.label ?? "Not on board"); break;
      case "project": comparison = compareText(projectName(a), projectName(b)); break;
      case "title": comparison = compareText(a.title, b.title); break;
      case "labels": comparison = compareText([...a.labels].sort(compareText).join(", "), [...b.labels].sort(compareText).join(", ")); break;
      case "tagged": comparison = compareText(taggedNames(a), taggedNames(b)); break;
      case "creator": comparison = compareText(names.get(a.authorId) || "Unknown user", names.get(b.authorId) || "Unknown user"); break;
      case "created": comparison = Date.parse(a.createdAt) - Date.parse(b.createdAt); break;
      default: comparison = a.number - b.number;
    }
    return (state.direction === "ascending" ? comparison : -comparison) || a.number - b.number || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}
