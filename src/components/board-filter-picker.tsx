import { useId, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "./ui/primitives";

/** Shadcn-style searchable picker backed by Radix Popover and native selection controls. */
export function BoardFilterPicker({ label, options, value, onChange, multiple = false, disabled }: {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  multiple?: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const id = useId();
  // Retain unavailable values so stale preferences can always be inspected and cleared.
  const choices = [...options, ...value.filter((item) => !options.some((option) => option.value === item)).map((item) => ({ value: item, label: `${item} (unavailable)` }))];
  const selected = choices.filter((option) => value.includes(option.value));
  const summary = multiple ? selected.length ? `${selected.length} selected` : "Any" : selected[0]?.label ?? "Any";
  return <Popover.Root open={open && !disabled} onOpenChange={(next) => { setOpen(next); if (next) setSearch(""); }}><div className="board-filter-field">
    <span id={`${id}-label`}>{label}</span>
    <Popover.Trigger asChild><Button variant="secondary" disabled={disabled} aria-label={`Filter board ${label.toLowerCase()}`} aria-describedby={`${id}-summary`}>
      <span id={`${id}-summary`}>{summary}</span><ChevronsUpDown size={14} />
    </Button></Popover.Trigger>
    <Popover.Portal><Popover.Content sideOffset={6} align="start" collisionPadding={12} aria-label={`Filter board ${label.toLowerCase()}`} className="board-filter-dialog">
      <p className="board-filter-help">{multiple ? "Choose all values that must match." : "Choose a value to filter by."}</p>
      <input className="board-filter-search" aria-label={`Search ${label.toLowerCase()} options`} placeholder="Find an option…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="board-filter-options" role="group" aria-labelledby={`${id}-label`}>
        {choices.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase())).map((option) => <label key={option.value} className="board-filter-option">
          <input type={multiple ? "checkbox" : "radio"} name={id} checked={value.includes(option.value)} onChange={(event) => {
            onChange(multiple ? event.target.checked ? [...value, option.value] : value.filter((item) => item !== option.value) : [option.value]);
            if (!multiple) setOpen(false);
          }} />
          <span>{option.label}</span>{value.includes(option.value) && <Check size={14} aria-hidden="true" />}
        </label>)}
        {!choices.some((option) => option.label.toLowerCase().includes(search.trim().toLowerCase())) && <p className="muted">No matching options</p>}
      </div>
      <div className="board-filter-dialog-actions"><Button variant="ghost" onClick={() => { onChange([]); if (!multiple) setOpen(false); }}>Reset {label.toLowerCase()}</Button><Button onClick={() => setOpen(false)}>Done</Button></div>
    </Popover.Content></Popover.Portal>
  </div></Popover.Root>;
}
