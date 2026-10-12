import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "./ui/primitives";
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

export function FilterBuilder({ value, onChange, fields, disabled = false, fixedField = false }: {
  value: IssueFilterGroup;
  onChange: (value: IssueFilterGroup) => void;
  fields: FilterFieldDefinition[];
  disabled?: boolean;
  fixedField?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const update = (id: string, patch: Partial<IssueFilter>) => onChange({ ...value, conditions: value.conditions.map((filter) => filter.id === id ? { ...filter, ...patch } : filter) });
  const focusRow = (index: number) => requestAnimationFrame(() => {
    const rows = root.current?.querySelectorAll<HTMLElement>(".filter-condition");
    const row = rows?.[Math.min(index, rows.length - 1)];
    (row?.querySelector<HTMLElement>("select") || addButton.current)?.focus();
  });
  return <div ref={root} className="filter-builder">
    <label className="filter-conjunction">Combine filters
      <select aria-label="Combine filters" disabled={disabled} value={value.conjunction} onChange={(event) => onChange({ ...value, conjunction: event.target.value as IssueFilterGroup["conjunction"] })}>
        <option value="and">Match all (AND)</option><option value="or">Match any (OR)</option>
      </select>
    </label>
    <div className="filter-conditions">
      {value.conditions.map((filter, index) => {
        const field = fields.find((field) => field.key === filter.field)!;
        if (!field) return null;
        const text = field.kind === "text" || field.kind === "number";
        const options = field.options || [];
        return <div key={filter.id} className="filter-condition" role="group" aria-label={`Filter ${index + 1}`}>
          {!fixedField && <label><span>Field</span><select aria-label="Field" disabled={disabled} value={filter.field} onChange={(event) => update(filter.id, { field: event.target.value as IssueFilterField, value: "", valueTo: undefined })}>
            {fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select></label>}
          <label><span>Operator</span><select aria-label="Operator" disabled={disabled} value={filter.operator} onChange={(event) => update(filter.id, { operator: event.target.value as IssueFilter["operator"] })}>
            <option value="is">{text ? "Contains" : field.kind === "date" ? "Is in range" : "Is"}</option>
            <option value="isNot">{text ? "Does not contain" : field.kind === "date" ? "Is outside range" : "Is not"}</option>
          </select></label>
          {field.kind === "date" ? <div className="filter-date-range">
            <label><span>From</span><input type="date" data-filter-value aria-label={field.fromLabel || "From"} disabled={disabled} value={filter.value} max={filter.valueTo || undefined} onChange={(event) => update(filter.id, { value: event.target.value })} /></label>
            <label><span>To</span><input type="date" aria-label={field.toLabel || "To"} disabled={disabled} value={filter.valueTo || ""} min={filter.value || undefined} onChange={(event) => update(filter.id, { valueTo: event.target.value })} /></label>
          </div> : <label className="filter-value"><span>Value</span>{text ?
            <input data-filter-value aria-label={field.valueLabel || "Value"} disabled={disabled} inputMode={field.kind === "number" ? "numeric" : undefined} placeholder={field.kind === "number" ? "Issue number…" : "Text…"} value={filter.value} onChange={(event) => update(filter.id, { value: event.target.value })} /> :
            <select data-filter-value aria-label={field.valueLabel || "Value"} disabled={disabled} value={filter.value} onChange={(event) => update(filter.id, { value: event.target.value })}>
              <option value="">Choose a value…</option>
              {filter.value && !options.some((option) => option.value === filter.value) && <option value={filter.value}>{filter.value.replace(/^(label:|user:)/, "")} (unavailable)</option>}
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>}
          </label>}
          <Button type="button" variant="ghost" className="filter-remove" disabled={disabled} aria-label={`Remove filter ${index + 1}`} onClick={() => { onChange({ ...value, conditions: value.conditions.filter((item) => item.id !== filter.id) }); focusRow(index); }}><X size={16} /></Button>
        </div>;
      })}
    </div>
    <Button ref={addButton} type="button" variant="secondary" disabled={disabled || !fields.length} onClick={() => {
      onChange({ ...value, conditions: [...value.conditions, { id: crypto.randomUUID(), field: fields[0].key, operator: "is", value: "" }] });
      focusRow(value.conditions.length);
    }}><Plus size={15} />Add filter</Button>
    <p className="muted filter-builder-help">{value.conjunction === "and" ? "Every condition must match." : "At least one condition must match."} Empty conditions are ignored. Search further narrows the results.{fixedField && " AND/OR applies across all table filters, including other columns."}</p>
  </div>;
}
