import type { BoardLane, Issue, User } from "../../shared/types";
import { emptyIssueFilters, matchesIssueFilters, type IssueFilterGroup } from "../lib/issue-filters";
import { FilterBuilder, type FilterFieldDefinition } from "./filter-builder";

export type BoardFilterState = IssueFilterGroup;
export const boardFilterFields = ["state", "lane", "labels", "tagged", "creator", "title", "number", "created"] as const;
export const emptyBoardFilters: BoardFilterState = emptyIssueFilters;
export function matchesBoardFilters(issue: Issue, lane: string | undefined, filters: BoardFilterState, users: readonly User[] = []) {
  return matchesIssueFilters(issue, filters, { users, lane });
}
export function BoardFilters({ value, onChange, lanes, tags, users, disabled }: {
  value: BoardFilterState;
  onChange: (value: BoardFilterState) => void;
  lanes: BoardLane[];
  tags: string[];
  users: User[];
  disabled: boolean;
}) {
  const fields: FilterFieldDefinition[] = [
    { key: "state", label: "State", options: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
    { key: "title", label: "Issue", kind: "text" },
    { key: "number", label: "Number", kind: "number" },
    { key: "lane", label: "Lane", options: [{ value: "none", label: "No lane" }, ...lanes.map((lane) => ({ value: lane.value, label: lane.label }))] },
    { key: "labels", label: "Tags", options: [{ value: "none", label: "No tags" }, ...tags.map((tag) => ({ value: `label:${tag}`, label: tag }))] },
    { key: "tagged", label: "Tagged users", options: [{ value: "none", label: "No tagged users" }, ...users.map((user) => ({ value: user.id, label: user.name }))] },
    { key: "creator", label: "Creator", options: [{ value: "unknown", label: "Unknown creator" }, ...users.map((user) => ({ value: `user:${user.id}`, label: user.name }))] },
    { key: "created", label: "Created", kind: "date" },
  ];
  return <section className="board-filters" aria-label="Board filters">
    <FilterBuilder value={value} onChange={onChange} fields={fields} disabled={disabled} />
  </section>;
}
