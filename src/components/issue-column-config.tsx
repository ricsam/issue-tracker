import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { IssueColumn } from "../lib/issue-table";
import { defaultIssueColumns, issueTableColumns, moveIssueColumn, type IssueColumnPreference } from "../lib/issue-table-columns";
import { Button, Modal } from "./ui/primitives";

export function IssueColumnConfig({ columns, includeProject, onSave, onClose, onRestoreFocus }: {
  columns: IssueColumnPreference[];
  includeProject: boolean;
  onSave: (columns: IssueColumnPreference[]) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const [draft, setDraft] = useState(columns);
  const [announcement, setAnnouncement] = useState("");
  const prefix = useId();
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (refocus.current) document.getElementById(refocus.current)?.focus();
    refocus.current = null;
  }, [draft]);
  function move(key: IssueColumn, label: string, direction: -1 | 1) {
    const next = moveIssueColumn(draft, key, direction);
    if (next === draft) return;
    refocus.current = `${prefix}-${key}-${direction}`;
    setDraft(next);
    setAnnouncement(`${label} moved to position ${next.findIndex((column) => column.key === key) + 1} of ${next.length}.`);
  }
  return <Modal open title="Table columns" description="Choose which columns to show and their left-to-right order. Saved for your account in this browser." onOpenChange={(open) => !open && onClose()} onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus(); }} className="issue-column-config">
    <form onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
      <ol className="issue-column-config-list" aria-label="Column order">
        {draft.map((column, index) => {
          const label = issueTableColumns.find(({ key }) => key === column.key)!.label;
          return <li key={column.key} className="issue-column-config-row">
            <label><input type="checkbox" checked={column.visible} disabled={column.key === "title"} aria-label={`Show ${label} column`} onChange={(event) => {
              const visible = event.target.checked;
              setDraft((current) => current.map((item) => item.key === column.key ? { ...item, visible } : item));
            }} /><span>{label}{column.key === "title" && <small className="muted">Always shown</small>}</span></label>
            <div className="issue-column-order-buttons">
              <button type="button" id={`${prefix}-${column.key}--1`} className="icon-button" aria-label={`Move ${label} column up`} aria-disabled={index === 0 || undefined} onClick={() => move(column.key, label, -1)}><ChevronUp size={18} /></button>
              <button type="button" id={`${prefix}-${column.key}-1`} className="icon-button" aria-label={`Move ${label} column down`} aria-disabled={index === draft.length - 1 || undefined} onClick={() => move(column.key, label, 1)}><ChevronDown size={18} /></button>
            </div>
          </li>;
        })}
      </ol>
      <p className="sr-only" role="status">{announcement}</p>
      <p className="muted issue-column-config-help">The Issue column stays visible so you can open issues. Hiding a column keeps its sorting and filters active.</p>
      <div className="issue-column-config-actions">
        <Button type="button" variant="ghost" onClick={() => { setDraft(defaultIssueColumns(includeProject)); setAnnouncement("Default columns restored. Save columns to apply."); }}>Reset to defaults</Button>
        <div><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit">Save columns</Button></div>
      </div>
    </form>
  </Modal>;
}
