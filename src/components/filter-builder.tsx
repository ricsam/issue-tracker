import { Fragment, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Plus, X } from "lucide-react";
import { Button } from "./ui/primitives";
import { Tooltip } from "./ui/tooltip";
import type { IssueFilter, IssueFilterField, IssueFilterGroup } from "../lib/issue-filters";
import "./filter-builder.css";

export interface FilterFieldDefinition {
  key: IssueFilterField;
  label: string;
  kind?: "text" | "number" | "date";
  options?: { value: string; label: string }[];
  valueLabel?: string;
  fromLabel?: string;
  toLabel?: string;
}

function operators(field: FilterFieldDefinition): { value: IssueFilter["operator"]; label: string }[] {
  const text = field.kind === "text" || field.kind === "number";
  return [
    { value: "is", label: text ? "contains" : field.kind === "date" ? "is in range" : "is" },
    { value: "isNot", label: text ? "does not contain" : field.kind === "date" ? "is outside range" : "is not" },
    ...(!field.kind ? [{ value: "isOneOf" as const, label: "is one of" }] : []),
    ...(["labels", "tagged"].includes(field.key) ? [{ value: "matchesEvery" as const, label: "matches every" }] : []),
  ];
}
const isMultiple = (operator: IssueFilter["operator"]) => operator === "isOneOf" || operator === "matchesEvery";
const optionLabel = (field: FilterFieldDefinition, value: string) => field.options?.find((option) => option.value === value)?.label
  || `${value.replace(/^(label:|user:)/, "")} (unavailable)`;
function summary(filter: IssueFilter, field: FilterFieldDefinition) {
  const displayValue = (value: string) => `${field.key === "labels" && value.startsWith("label:") ? "#" : ""}${optionLabel(field, value)}`;
  const values = isMultiple(filter.operator) ? (filter.values ?? (filter.value ? [filter.value] : [])).map(displayValue).join(", ")
    : field.kind === "date" ? `${filter.value || "Any date"} – ${filter.valueTo || "Any date"}`
    : field.kind ? filter.value.trim() : filter.value ? displayValue(filter.value) : "";
  return `${field.label} ${operators(field).find((operator) => operator.value === filter.operator)?.label || "is"} ${values || "…"}`;
}

function FilterEditor({ filter, field, fields, update, disabled }: {
  filter: IssueFilter; field: FilterFieldDefinition; fields: FilterFieldDefinition[];
  update: (patch: Partial<IssueFilter>) => void; disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const text = field.kind === "text" || field.kind === "number";
  const multiple = isMultiple(filter.operator);
  const selected = multiple ? filter.values ?? (filter.value ? [filter.value] : []) : filter.value ? [filter.value] : [];
  const options = [...field.options || [], ...selected.filter((value) => !field.options?.some((option) => option.value === value)).map((value) => ({ value, label: optionLabel(field, value) }))];
  return <div className="filter-editor-fields">
    <label>Field<select aria-label="Field" disabled={disabled} value={filter.field} onChange={(event) => {
      setSearch("");
      update({ field: event.target.value as IssueFilterField, operator: "is", value: "", valueTo: undefined, values: undefined });
    }}>{fields.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    <label>Operator<select aria-label="Operator" disabled={disabled} value={filter.operator} onChange={(event) => {
      const operator = event.target.value as IssueFilter["operator"];
      update({ operator, values: isMultiple(operator) ? multiple ? selected : filter.value ? [filter.value] : [] : undefined,
        value: multiple && !isMultiple(operator) ? selected[0] || "" : filter.value });
    }}>{operators(field).map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></label>
    {field.kind === "date" ? <div className="filter-date-range">
      <label>From<input type="date" aria-label={field.fromLabel || "From"} disabled={disabled} value={filter.value} max={filter.valueTo || undefined} onChange={(event) => update({ value: event.target.value })} /></label>
      <label>To<input type="date" aria-label={field.toLabel || "To"} disabled={disabled} value={filter.valueTo || ""} min={filter.value || undefined} onChange={(event) => update({ valueTo: event.target.value })} /></label>
    </div> : multiple ? <>
      <label>Values<input type="search" aria-label="Find filter values" placeholder="Find a value…" value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} /></label>
      <div className="filter-value-options" role="group" aria-label="Filter values">
        {options.filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((option) => <label key={option.value}>
          <input type="checkbox" disabled={disabled} checked={selected.includes(option.value)} onChange={(event) => update({ values: event.target.checked ? [...selected, option.value] : selected.filter((value) => value !== option.value) })} /><span>{option.label}</span>
        </label>)}
        {!options.some((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p className="muted">No matching values.</p>}
      </div>
      <p className="muted filter-editor-help">{filter.operator === "matchesEvery" ? "All selected values must match." : "Any selected value can match."} {selected.length} selected.</p>
    </> : <label>Value{text ? <input aria-label={field.valueLabel || "Value"} disabled={disabled} inputMode={field.kind === "number" ? "numeric" : undefined} placeholder={field.kind === "number" ? "Issue number…" : "Text…"} value={filter.value} onChange={(event) => update({ value: event.target.value })} />
      : <select aria-label={field.valueLabel || "Value"} disabled={disabled} value={filter.value} onChange={(event) => update({ value: event.target.value })}>
        <option value="">Choose a value…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}</label>}
  </div>;
}

export function FilterBuilder({ value, onChange, fields, disabled = false }: {
  value: IssueFilterGroup;
  onChange: (value: IssueFilterGroup) => void;
  fields: FilterFieldDefinition[];
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const update = (id: string, patch: Partial<IssueFilter>) => onChange({ ...value, conditions: value.conditions.map((filter) => filter.id === id ? { ...filter, ...patch } : filter) });
  const remove = (id: string, index: number) => {
    setEditing(null);
    onChange({ ...value, conditions: value.conditions.filter((filter) => filter.id !== id) });
    requestAnimationFrame(() => {
      const chips = root.current?.querySelectorAll<HTMLButtonElement>(".filter-chip-edit");
      (chips?.[Math.min(index, chips.length - 1)] || addButton.current)?.focus();
    });
  };
  return <div ref={root} className="filter-builder">
    <div className="filter-chips">
      {value.conditions.map((filter, index) => {
        const field = fields.find((field) => field.key === filter.field);
        if (!field) return null;
        const label = summary(filter, field);
        return <Fragment key={filter.id}>
          {index > 0 && <span className="filter-join" aria-hidden="true">{value.conjunction.toUpperCase()}</span>}
          <Popover.Root open={editing === filter.id && !disabled} onOpenChange={(open) => setEditing(open ? filter.id : null)}>
            <div className="filter-chip">
              <Tooltip content={label}><Popover.Trigger asChild><button type="button" className="filter-chip-edit" disabled={disabled} aria-label={`Edit filter: ${label}`}>{label}</button></Popover.Trigger></Tooltip>
              <button type="button" className="filter-chip-remove" aria-label={`Remove filter: ${label}`} disabled={disabled} onClick={() => remove(filter.id, index)}><X size={14} /></button>
            </div>
            <Popover.Portal><Popover.Content className="filter-editor" align="start" sideOffset={8} collisionPadding={12} aria-label="Edit filter">
              <strong>Edit filter</strong>
              <FilterEditor filter={filter} field={field} fields={fields} disabled={disabled} update={(patch) => update(filter.id, patch)} />
              <div className="filter-editor-actions"><Button type="button" variant="ghost" disabled={disabled} onClick={() => remove(filter.id, index)}>Remove filter</Button><Popover.Close asChild><Button type="button">Done</Button></Popover.Close></div>
            </Popover.Content></Popover.Portal>
          </Popover.Root>
        </Fragment>;
      })}
      <Button ref={addButton} type="button" variant="ghost" className="filter-add" disabled={disabled || !fields.length} onClick={() => {
        const id = crypto.randomUUID();
        onChange({ ...value, conditions: [...value.conditions, { id, field: fields.find((field) => field.key === "title")?.key || fields[0].key, operator: "is", value: "" }] });
        setEditing(id);
      }}>Add filter<Plus size={14} /></Button>
    </div>
    <div className="filter-bar-controls">
      <div className="filter-conjunction"><span className={value.conjunction === "and" ? "filter-mode-active" : ""}>AND</span>
        <button type="button" role="switch" aria-label="Match any filter (OR)" aria-describedby={helpId} aria-checked={value.conjunction === "or"} className="filter-conjunction-switch" disabled={disabled} onClick={() => onChange({ ...value, conjunction: value.conjunction === "and" ? "or" : "and" })}><span /></button>
        <span className={value.conjunction === "or" ? "filter-mode-active" : ""}>OR</span>
      </div>
      {value.conditions.length > 0 && <Button type="button" variant="ghost" className="filter-clear" disabled={disabled} onClick={() => { setEditing(null); onChange({ conjunction: "and", conditions: [] }); addButton.current?.focus(); }}>Clear filters</Button>}
    </div>
    <span id={helpId} className="sr-only">{value.conjunction === "and" ? "Every filter must match." : "At least one filter must match."} Empty filters are ignored. Search further narrows the results.</span>
  </div>;
}
