import { useId } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import type { BoardLane, Issue, User } from "../../shared/types";
import { Button } from "./ui/primitives";
import { BoardFilterPicker } from "./board-filter-picker";
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
  const count = Number(value.state !== "all") + Number(!!value.lane) + value.tags.length + value.users.length + Number(!!value.creator) + Number(!!search.trim());
  const people = users.map((user) => ({ value: user.id, label: user.name }));
  return <Collapsible.Root asChild open={expanded} onOpenChange={onExpandedChange}><section className="board-filters" aria-label="Board filters">
    <div className="board-filters-heading">
      <Collapsible.Trigger asChild><Button variant="ghost" aria-controls={id}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<SlidersHorizontal size={15} /> Filter board
        {count > 0 && <span className="board-filter-badge">{count} active{search.trim() ? " · search" : ""}</span>}
      </Button></Collapsible.Trigger>
      <Button variant="ghost" disabled={!count || disabled} onClick={onClear}>Clear filters</Button>
    </div>
    <Collapsible.Content id={id}>
      <div className="board-filter-fields">
        <BoardFilterPicker label="State" options={[{ value: "all", label: "All states" }, { value: "open", label: "Open" }, { value: "closed", label: "Closed" }]} value={[value.state]} onChange={(items) => onChange({ ...value, state: (items[0] ?? "all") as BoardFilterState["state"] })} disabled={disabled} />
        <BoardFilterPicker label="Lane" options={lanes.map((lane) => ({ value: lane.value, label: lane.label }))} value={value.lane ? [value.lane] : []} onChange={(items) => onChange({ ...value, lane: items[0] ?? "" })} disabled={disabled} />
        <BoardFilterPicker label="Tags" options={tags.map((tag) => ({ value: tag, label: tag }))} value={value.tags} onChange={(items) => onChange({ ...value, tags: items })} multiple disabled={disabled} />
        <BoardFilterPicker label="Tagged users" options={people} value={value.users} onChange={(items) => onChange({ ...value, users: items })} multiple disabled={disabled} />
        <BoardFilterPicker label="Creator" options={people} value={value.creator ? [value.creator] : []} onChange={(items) => onChange({ ...value, creator: items[0] ?? "" })} disabled={disabled} />
      </div>
      <p className="muted board-filter-help">All selected filters must match. Filters and collapsed lanes are saved for you on this device.</p>
    </Collapsible.Content>
  </section></Collapsible.Root>;
}
