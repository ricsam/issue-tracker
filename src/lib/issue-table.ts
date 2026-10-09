import type { Issue, Project, User } from "../../shared/types";

export type IssueColumn = "number" | "title" | "labels" | "tagged" | "created" | "project";
export interface IssueTableState {
  sort: IssueColumn;
  direction: "ascending" | "descending";
  number: string;
  title: string;
  label: string;
  tagged: string;
  project: string;
  createdFrom: string;
  createdTo: string;
}
export const initialIssueTableState: IssueTableState = {
  sort: "number",
  direction: "ascending",
  number: "",
  title: "",
  label: "",
  tagged: "",
  project: "",
  createdFrom: "",
  createdTo: "",
};

export function hasColumnFilters(state: IssueTableState) {
  return !!(state.number || state.title || state.label || state.tagged || state.project || state.createdFrom || state.createdTo);
}

/** Compare/filter the same local calendar dates that the table displays. */
export function issueDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function issueTableRows(issues: Issue[], users: User[], state: IssueTableState, projects: Project[] = []) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const projectName = (issue: Issue) => issue.projectId ? projectNames.get(issue.projectId) || issue.projectId : "No project";
  const names = new Map(users.map((user) => [user.id, user.name]));
  const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const taggedNames = (issue: Issue) => issue.taggedUserIds.map((id) => names.get(id) || id).sort(compareText).join(", ");
  return issues.filter((issue) => {
    const date = issueDateKey(issue.createdAt);
    return (
      String(issue.number).includes(state.number.trim().replace(/^#/, "")) &&
      issue.title.toLocaleLowerCase().includes(state.title.trim().toLocaleLowerCase()) &&
      (!state.label || (state.label === "none" ? issue.labels.length === 0 : issue.labels.includes(state.label.slice(6)))) &&
      (!state.tagged || (state.tagged === "none" ? issue.taggedUserIds.length === 0 : issue.taggedUserIds.includes(state.tagged))) &&
      (!state.project || (state.project === "none" ? issue.projectId === null : issue.projectId === state.project)) &&
      (!state.createdFrom || date >= state.createdFrom) &&
      (!state.createdTo || date <= state.createdTo)
    );
  }).sort((a, b) => {
    let comparison: number;
    switch (state.sort) {
      case "project": comparison = compareText(projectName(a), projectName(b)); break;
      case "title": comparison = compareText(a.title, b.title); break;
      case "labels": comparison = compareText([...a.labels].sort(compareText).join(", "), [...b.labels].sort(compareText).join(", ")); break;
      case "tagged": comparison = compareText(taggedNames(a), taggedNames(b)); break;
      case "created": comparison = Date.parse(a.createdAt) - Date.parse(b.createdAt); break;
      default: comparison = a.number - b.number;
    }
    return (state.direction === "ascending" ? comparison : -comparison) || a.number - b.number || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}
