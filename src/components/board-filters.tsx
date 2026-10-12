import { useId } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import type { BoardLane, Issue, User } from "../../shared/types";
import { emptyIssueFilters, isActiveIssueFilter, matchesIssueFilters, type IssueFilterGroup } from "../lib/issue-filters";
import { Button } from "./ui/primitives";
import { FilterBuilder, type FilterFieldDefinition } from "./filter-builder";
import "./board-filters.css";

export type BoardFilterState = IssueFilterGroup;
export const boardFilterFields = ["state", "lane", "labels", "tagged", "creator"] as const;
export const emptyBoardFilters: BoardFilterState = emptyIssueFilters;
export function matchesBoardFilters(issue: Issue, lane: string | undefined, filters: BoardFilterState, users: readonly User[] = []) {
  return matchesIssueFilters(issue, filters, { users, lane });
}
export function BoardFilters({ value, onChange, onClear, lanes, tags, users, search, expanded, onExpandedChange, disabled }: {
  value: BoardFilterState;
  onChange: (value: BoardFilterState) => void;
  onClear: () => void;
  lanes: BoardLane[];
  tags: string[];
  users: User[];
  search: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  const count = value.conditions.filter(isActiveIssueFilter).length + Number(!!search.trim());
  const fields: FilterFieldDefinition[] = [
    { key: "state", label: "State", options: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
    { key: "lane", label: "Lane", options: [{ value: "none", label: "No lane" }, ...lanes.map((lane) => ({ value: lane.value, label: lane.label }))] },
    { key: "labels", label: "Tags", options: [{ value: "none", label: "No tags" }, ...tags.map((tag) => ({ value: `label:${tag}`, label: tag }))] },
    { key: "tagged", label: "Tagged users", options: [{ value: "none", label: "No tagged users" }, ...users.map((user) => ({ value: user.id, label: user.name }))] },
    { key: "creator", label: "Creator", options: [{ value: "unknown", label: "Unknown creator" }, ...users.map((user) => ({ value: `user:${user.id}`, label: user.name }))] },
  ];
  return <Collapsible.Root asChild open={expanded} onOpenChange={onExpandedChange}><section className="board-filters" aria-label="Board filters">
    <div className="board-filters-heading">
      <Collapsible.Trigger asChild><Button variant="ghost" aria-controls={id}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<SlidersHorizontal size={15} /> Filter board
        {count > 0 && <span className="board-filter-badge">{count} active{search.trim() ? " · search" : ""}</span>}
      </Button></Collapsible.Trigger>
      <Button variant="ghost" disabled={(!value.conditions.length && !search) || disabled} onClick={onClear}>Clear filters</Button>
    </div>
    <Collapsible.Content id={id}>
      <FilterBuilder value={value} onChange={onChange} fields={fields} disabled={disabled} />
      <p className="muted board-filter-help">Filters and collapsed lanes are saved for you on this device.</p>
    </Collapsible.Content>
  </section></Collapsible.Root>;
}
