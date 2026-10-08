import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from "lucide-react";
import type { Issue, User } from "../../shared/types";
import { hasColumnFilters, initialIssueTableState, type IssueColumn, type IssueTableState } from "../lib/issue-table";
import { Button } from "./ui/primitives";
import { ClosedTag } from "./lifecycle";
import "./issue-table.css";

const columns: { key: IssueColumn; label: string }[] = [
  { key: "number", label: "Number" }, { key: "title", label: "Issue" },
  { key: "labels", label: "Labels" }, { key: "tagged", label: "Tagged users" },
  { key: "created", label: "Created" },
];

function FilterPopover({ label, active, onClear, children }: { label: string; active: boolean; onClear: () => void; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const position = () => {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    panel.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
    panel.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8))}px`;
  };
  useEffect(() => {
    if (!open) return;
    position();
    panel.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className={`column-filter-trigger${active ? " is-active" : ""}`} popoverTarget={id} aria-label={`${label} filters${active ? " (active)" : ""}`} aria-expanded={open} aria-controls={id} aria-haspopup="dialog"><Filter size={13} /></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={`${label} filters`} className="issue-filter-popover" onToggle={(event) => setOpen(event.newState === "open")}>
      <strong>{label} filters</strong>
      {children}
      <div className="filter-popover-actions"><Button type="button" variant="ghost" disabled={!active} onClick={onClear}>Clear {label.toLowerCase()} filter</Button><Button type="button" variant="ghost" onClick={() => { panel.current?.hidePopover(); trigger.current?.focus(); }}>Done</Button></div>
    </div>
  </>;
}

export function IssueTable({ issues, allIssues, users, state, onChange, selectedId, controls, onOpen, onNavigate, paginationKey, readOnly = false, onCloseIssues, onTagIssues, onLabelIssues }: {
  issues: Issue[]; allIssues: Issue[]; users: User[]; state: IssueTableState;
  onChange: (state: IssueTableState) => void; selectedId: string | null; controls?: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, issue: Issue) => void;
  onNavigate: (issue: Issue, opener: HTMLAnchorElement) => boolean;
  onTagIssues: (ids: string[]) => void;
  onLabelIssues: (ids: string[]) => void;
  paginationKey: string; readOnly?: boolean;
  onCloseIssues: (ids: string[]) => Promise<{ closedIds: string[]; error?: string }>;
}) {
  const [pageSize, setPageSize] = useState(25);
  const resetKey = JSON.stringify([paginationKey, state]);
  const [paging, setPaging] = useState({ key: resetKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(issues.length / pageSize));
  const page = paging.key === resetKey ? Math.min(paging.page, pageCount - 1) : 0;
  useEffect(() => { setPaging({ key: resetKey, page }); }, [resetKey, page]);
  const [selection, setSelection] = useState<string[]>([]);
  const eligible = new Set(readOnly ? [] : issues.map((issue) => issue.id));
  const selected = selection.filter((id) => eligible.has(id));
  const selectedOpen = selected.filter((id) => issues.some((issue) => issue.id === id && issue.state === "open"));
  const eligibleKey = JSON.stringify([...eligible].sort());
  useEffect(() => { setSelection((ids) => ids.filter((id) => eligible.has(id))); }, [eligibleKey]);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState("");
  const rows = issues.slice(page * pageSize, (page + 1) * pageSize);
  const pageIds = rows.filter((issue) => eligible.has(issue.id)).map((issue) => issue.id);
  const checkedCount = pageIds.filter((id) => selected.includes(id)).length;
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headerCheckbox.current) headerCheckbox.current.indeterminate = checkedCount > 0 && checkedCount < pageIds.length; }, [checkedCount, pageIds.length]);
  const closeSelected = async () => {
    if (inFlight.current || readOnly || !selectedOpen.length) return;
    inFlight.current = true; setPending(true); setOutcome("");
    const ids = [...selectedOpen];
    try {
      const result = await onCloseIssues(ids);
      const closed = new Set(result.closedIds.filter((id) => ids.includes(id)));
      setSelection((current) => current.filter((id) => !closed.has(id)));
      setOutcome(result.error ? `${closed.size} of ${ids.length} issues closed. ${result.error}` : closed.size ? `${closed.size} ${closed.size === 1 ? "issue" : "issues"} closed.${closed.size < ids.length ? ` ${ids.length - closed.size} not closed.` : ""}` : "No issues closed.");
    } catch (error) { setOutcome(`Could not close issues. ${error instanceof Error ? error.message : "Please try again."}`); }
    finally { inFlight.current = false; setPending(false); }
  };
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const activeId = useRef<string | null>(null);
  const focusAfterPage = useRef<string | null>(null);
  const range = useRef<{ key: string; anchor: string; base: string[] } | null>(null);
  // Include visible ordering: refreshes which remove/reorder issues invalidate a range,
  // whereas ordinary pagination keeps its anchor.
  const orderKey = JSON.stringify([resetKey, issues.map((issue) => issue.id)]);
  const selectRange = (id: string, fallback: string = id) => {
    if (pending || inFlight.current || readOnly) return;
    if (!range.current || range.current.key !== orderKey) range.current = { key: orderKey, anchor: fallback, base: [...selected] };
    const anchor = issues.findIndex((issue) => issue.id === range.current!.anchor);
    const end = issues.findIndex((issue) => issue.id === id);
    if (anchor < 0 || end < 0) return;
    const ids = issues.slice(Math.min(anchor, end), Math.max(anchor, end) + 1).filter((issue) => eligible.has(issue.id)).map((issue) => issue.id);
    setSelection([...new Set([...range.current.base, ...ids])]);
  };
  useEffect(() => {
    const id = focusAfterPage.current;
    if (id && links.current.has(id)) { links.current.get(id)!.focus(); focusAfterPage.current = null; }
  }, [page, orderKey]);
  const keyboardNavigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    // Only rows participate; editors, filters and the select-all checkbox keep
    // their own keyboard behavior. Row checkboxes also support Shift+arrows.
    const row = target.closest("tbody tr");
    if (target !== event.currentTarget && !target.closest("a.issue-link") && !(row && target.matches('input[type="checkbox"]'))) return;
    if (pending || inFlight.current || event.shiftKey && readOnly || !issues.length) return;
    const sourceId = row?.querySelector<HTMLAnchorElement>("a.issue-link")?.dataset.issueId || [activeId.current, selectedId].find((id) => rows.some((issue) => issue.id === id));
    const index = issues.findIndex((issue) => issue.id === sourceId);
    const next = index < 0 ? page * pageSize : Math.max(0, Math.min(issues.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    if (next === index) return;
    const issue = issues[next];
    const opener = links.current.get(issue.id) || (sourceId ? links.current.get(sourceId) : undefined) || links.current.get(rows[0]?.id);
    if (!opener) return;
    if (event.shiftKey) selectRange(issue.id, sourceId || issue.id);
    else {
      if (!onNavigate(issue, opener)) return;
      range.current = { key: orderKey, anchor: issue.id, base: [...selected] };
    }
    activeId.current = issue.id;
    const nextPage = Math.floor(next / pageSize);
    if (nextPage !== page) { focusAfterPage.current = issue.id; setPaging({ key: resetKey, page: nextPage }); }
    else links.current.get(issue.id)?.focus();
  };
  const labels = [...new Set(allIssues.flatMap((issue) => issue.labels))].sort((a, b) => a.localeCompare(b));
  const patch = (value: Partial<IssueTableState>) => onChange({ ...state, ...value });
  const empty = (label: string) => <span className="muted empty-cell" aria-label={label}>—</span>;
  const filters: Record<IssueColumn, { active: boolean; clear: () => void; content: ReactNode }> = {
    number: { active: !!state.number, clear: () => patch({ number: "" }), content: <input aria-label="Filter by number" placeholder="#" inputMode="numeric" value={state.number} onChange={(e) => patch({ number: e.target.value })} /> },
    title: { active: !!state.title, clear: () => patch({ title: "" }), content: <input aria-label="Filter by issue" placeholder="Filter title…" value={state.title} onChange={(e) => patch({ title: e.target.value })} /> },
    labels: { active: !!state.label, clear: () => patch({ label: "" }), content: <select aria-label="Filter by label" value={state.label} onChange={(e) => patch({ label: e.target.value })}><option value="">All labels</option><option value="none">No labels</option>{labels.map((label) => <option key={label} value={`label:${label}`}>{label}</option>)}</select> },
    tagged: { active: !!state.tagged, clear: () => patch({ tagged: "" }), content: <select aria-label="Filter by tagged user" value={state.tagged} onChange={(e) => patch({ tagged: e.target.value })}><option value="">Anyone</option><option value="none">No tagged users</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}</select> },
    created: { active: !!(state.createdFrom || state.createdTo), clear: () => patch({ createdFrom: "", createdTo: "" }), content: <div className="date-filter"><label><span>From</span><input type="date" aria-label="Created on or after" value={state.createdFrom} max={state.createdTo || undefined} onChange={(e) => patch({ createdFrom: e.target.value })} /></label><label><span>To</span><input type="date" aria-label="Created on or before" value={state.createdTo} min={state.createdFrom || undefined} onChange={(e) => patch({ createdTo: e.target.value })} /></label></div> },
  };
  return <section className="issue-table-section" aria-label="Issue list">
    <div className="issue-bulk-actions issue-table-actions" role="group" aria-label="Selected issue actions" aria-busy={pending}>
      <p className="issue-table-count muted">{issues.length} of {allIssues.length} issues</p>
      <span className="issue-selection-count">{selected.length} selected</span>
      <Button type="button" disabled={pending || readOnly || !selectedOpen.length} onClick={closeSelected}>{pending ? "Closing…" : "Close selected issues"}</Button>
      <Button type="button" disabled={pending || readOnly || !selected.length} onClick={() => onTagIssues([...selected])}>Tag selected issues</Button>
      <Button type="button" disabled={pending || readOnly || !selected.length} onClick={() => onLabelIssues([...selected])}>Add hashtags</Button>
      <Button type="button" variant="ghost" disabled={pending || !selected.length} onClick={() => { setSelection([]); range.current = null; }}>Clear selection</Button>
      {hasColumnFilters(state) && <Button type="button" variant="ghost" onClick={() => onChange({ ...initialIssueTableState, sort: state.sort, direction: state.direction })}>Clear column filters</Button>}
    </div>
    <p className="issue-bulk-outcome" role="status">{outcome}</p>
    <div className="issue-table-scroll" tabIndex={0} role="region" aria-label="Scrollable issues table" onKeyDown={keyboardNavigate}>
      <table className="issue-table">
        <caption className="sr-only">Issues. Use column headings to sort and filter. Select issues to add hashtags, tag teammates or close selected open issues. Up and Down open adjacent issues. Hold Shift with arrows or click to select a range.</caption>
        <colgroup><col className="selection-column" /><col className="number-column" /><col className="title-column" /><col className="labels-column" /><col className="users-column" /><col className="date-column" /></colgroup>
        <thead><tr><th scope="col"><input ref={headerCheckbox} type="checkbox" aria-label="Select all issues on this page" checked={pageIds.length > 0 && checkedCount === pageIds.length} disabled={pending || !pageIds.length} onChange={(event) => { const checked = event.target.checked; range.current = null; setSelection((current) => checked ? [...new Set([...current, ...pageIds])] : current.filter((id) => !pageIds.includes(id))); }} /></th>
          {columns.map(({ key, label }) => <th key={key} scope="col" aria-sort={state.sort === key ? state.direction : "none"}><div className="issue-column-heading"><button type="button" className="column-sort" aria-label={`Sort by ${label.toLowerCase()}`} onClick={() => patch({ sort: key, direction: state.sort === key && state.direction === "ascending" ? "descending" : "ascending" })}>{label}{state.sort !== key ? <ArrowUpDown size={13} /> : state.direction === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button><FilterPopover label={label} active={filters[key].active} onClear={filters[key].clear}>{filters[key].content}</FilterPopover></div></th>)}
        </tr></thead>
        <tbody>{rows.map((issue) => <tr key={issue.id} onClickCapture={(event) => { if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).matches('input[type="checkbox"]')) return; event.preventDefault(); event.stopPropagation(); selectRange(issue.id); activeId.current = issue.id; links.current.get(issue.id)?.focus(); }} className={`issue-row${selectedId === issue.id ? " is-selected" : ""}${selected.includes(issue.id) ? " is-bulk-selected" : ""}`}>
          <td><input type="checkbox" aria-label={`Select issue #${issue.number}`} checked={selected.includes(issue.id)} disabled={pending || !eligible.has(issue.id)} onChange={(event) => { if ((event.nativeEvent as globalThis.MouseEvent).shiftKey) { selectRange(issue.id); activeId.current = issue.id; links.current.get(issue.id)?.focus(); return; } const checked = event.target.checked; activeId.current = issue.id; range.current = { key: orderKey, anchor: issue.id, base: selected.filter((id) => id !== issue.id) }; setSelection((current) => checked ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id)); }} /></td>
          <td className="issue-number">#{issue.number}</td><td><Link ref={(node) => { if (node) links.current.set(issue.id, node); else links.current.delete(issue.id); }} data-issue-id={issue.id} className="issue-link" to={`/issues/${issue.id}`} onClick={(event) => { if (!event.altKey && !event.ctrlKey && !event.metaKey && event.button === 0) { activeId.current = issue.id; range.current = { key: orderKey, anchor: issue.id, base: [...selected] }; } onOpen(event, issue); }} aria-current={selectedId === issue.id ? "true" : undefined} aria-controls={controls} aria-label={`#${issue.number} ${issue.title}`}><strong>{issue.title}</strong>{issue.state === "closed" && <ClosedTag />}</Link></td>
          <td><div className="issue-meta">{issue.labels.length ? issue.labels.map((label) => <span className="tag" key={label} title={label}>{label}</span>) : empty("No labels")}</div></td>
          <td><div className="issue-meta">{issue.taggedUserIds.length ? issue.taggedUserIds.map((id) => { const user = users.find((candidate) => candidate.id === id); return <span className="tag user-tag" key={id} title={user?.email}>{user?.name || "Unknown user"}</span>; }) : empty("No tagged users")}</div></td>
          <td><time dateTime={issue.createdAt} title={new Date(issue.createdAt).toLocaleString()}>{new Date(issue.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time></td>
        </tr>)}{!issues.length && <tr><td colSpan={6} className="table-empty">{allIssues.length ? "No matching issues. Adjust or clear your filters." : "No issues in this view."}</td></tr>}</tbody>
      </table>
    </div>
    <nav className="issue-pagination" aria-label="Issue list pagination"><label>Rows per page <select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPaging({ key: resetKey, page: 0 }); }}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><span>{issues.length ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, issues.length)} of {issues.length}</span><span>Page {page + 1} of {pageCount}</span><Button type="button" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPaging({ key: resetKey, page: page - 1 })}>Previous</Button><Button type="button" variant="ghost" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPaging({ key: resetKey, page: page + 1 })}>Next</Button></nav>
  </section>;
}
