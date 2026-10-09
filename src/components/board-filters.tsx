import type { BoardLane, Issue, User } from "../../shared/types";
import { Button } from "./ui/primitives";
import "./board-filters.css";

export interface BoardFilterState {
  state: "all" | "open" | "closed";
  lane: string;
  tags: string[];
  users: string[];
  creator: string;
}
export const emptyBoardFilters: BoardFilterState = { state: "all", lane: "", tags: [], users: [], creator: "" };

export function matchesBoardFilters(issue: Issue, lane: string | undefined, filters: BoardFilterState) {
  return (filters.state === "all" || issue.state === filters.state)
    && (!filters.lane || lane === filters.lane)
    && filters.tags.every((tag) => issue.labels.includes(tag))
    && filters.users.every((id) => issue.taggedUserIds.includes(id))
    && (!filters.creator || issue.authorId === filters.creator);
}

export function BoardFilters({ value, onChange, onClear, lanes, tags, users, active, disabled }: {
  value: BoardFilterState;
  onChange: (value: BoardFilterState) => void;
  onClear: () => void;
  lanes: BoardLane[];
  tags: string[];
  users: User[];
  active: boolean;
  disabled: boolean;
}) {
  return <fieldset className="board-filters" disabled={disabled}>
    <legend>Filter board</legend>
    <label>State<select aria-label="Filter board state" value={value.state} onChange={(event) => onChange({ ...value, state: event.target.value as BoardFilterState["state"] })}>
      <option value="all">All states</option><option value="open">Open</option><option value="closed">Closed</option>
    </select></label>
    <label>Lane<select aria-label="Filter board lane" value={value.lane} onChange={(event) => onChange({ ...value, lane: event.target.value })}>
      <option value="">All lanes</option>{lanes.map((lane) => <option key={lane.value} value={lane.value}>{lane.label}</option>)}
    </select></label>
    <label>Tags<select multiple aria-label="Filter board tags" value={value.tags} onChange={(event) => onChange({ ...value, tags: Array.from(event.target.selectedOptions, (option) => option.value) })}>
      {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
    </select></label>
    <label>Tagged users<select multiple aria-label="Filter board tagged users" value={value.users} onChange={(event) => onChange({ ...value, users: Array.from(event.target.selectedOptions, (option) => option.value) })}>
      {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select></label>
    <label>Creator<select aria-label="Filter board creator" value={value.creator} onChange={(event) => onChange({ ...value, creator: event.target.value })}>
      <option value="">All creators</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select></label>
    <Button variant="ghost" disabled={!active || disabled} onClick={onClear}>Clear filters</Button>
    <span className="muted board-filter-help">All selected filters must match. Use Ctrl or Cmd to select multiple tags or users.</span>
  </fieldset>;
}
