import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import type { BoardSettings, Issue, Project, User } from "../../shared/types";
import type { IssueColumn, IssueTableState } from "../lib/issue-table";
import { Button } from "./ui/primitives";
import { Tooltip } from "./ui/tooltip";
import { useNotification } from "./ui/snackbar";
import { ExternalLinks } from "./plugin-issue";
import { IssueStateBadge } from "./lifecycle";
import { SendToBoardDialog } from "./send-to-board-dialog";
import type { BoardLaneOption, IssueBoardLane } from "../lib/issue-board-lanes";
import { useWorkspace } from "../lib/workspace";
import { defaultIssueColumns, issueColumnsStorageKey, issueTableColumns, normalizeIssueColumns, type IssueColumnPreference } from "../lib/issue-table-columns";
import { IssueColumnConfig } from "./issue-column-config";
import { issuePageSizes, issuePageSizeStorageKey, normalizeIssuePageSize, readIssuePageSize } from "../lib/issue-pagination";
import { FilterBuilder, type FilterFieldDefinition } from "./filter-builder";
import "./issue-table.css";

export function IssueTable({ issues, allIssues, users, projects, boardLanes, laneOptions, state, onChange, selectedId, controls, onOpen, onNavigate, paginationKey, preferenceScope, readOnly = false, onCloseIssues, onTagIssues, onLabelIssues, onBoardChanged }: {
  issues: Issue[]; allIssues: Issue[]; users: User[]; projects?: Project[]; state: IssueTableState;
  boardLanes: ReadonlyMap<string, IssueBoardLane>;
  laneOptions: BoardLaneOption[];
  onChange: (state: IssueTableState) => void; selectedId: string | null; controls?: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, issue: Issue) => void;
  onNavigate: (issue: Issue, opener: HTMLAnchorElement) => boolean;
  onTagIssues: (ids: string[]) => void;
  onLabelIssues: (ids: string[]) => void;
  onBoardChanged: (projectId: string, board: BoardSettings) => void;
  paginationKey: string; preferenceScope: string; readOnly?: boolean;
  onCloseIssues: (ids: string[]) => Promise<{ closedIds: string[]; error?: string }>;
}) {
  const { user } = useWorkspace();
  const includeProject = !!projects;
  const storageKey = issueColumnsStorageKey(user.id, includeProject);
  const [columnPreferences, setColumnPreferences] = useState(() => {
    try { return normalizeIssueColumns(JSON.parse(localStorage.getItem(storageKey) || "null"), includeProject); }
    catch { return defaultIssueColumns(includeProject); }
  });
  const [configuringColumns, setConfiguringColumns] = useState(false);
  const columnsButton = useRef<HTMLButtonElement>(null);
  const closeColumnConfig = () => setConfiguringColumns(false);
  const saveColumns = (columns: IssueColumnPreference[]) => {
    const normalized = normalizeIssueColumns(columns, includeProject);
    setColumnPreferences(normalized);
    try { localStorage.setItem(storageKey, JSON.stringify(normalized)); }
    catch { notify("Columns updated for this visit, but browser storage is unavailable.", "error"); }
    closeColumnConfig();
  };
  const pageSizeKey = issuePageSizeStorageKey(user.id, preferenceScope);
  const [pageSizePreference, setPageSizePreference] = useState(() => ({ key: pageSizeKey, value: readIssuePageSize(pageSizeKey) }));
  // Never carry one account/list's value into another, even if the table is reused.
  const pageSize = pageSizePreference.key === pageSizeKey ? pageSizePreference.value : readIssuePageSize(pageSizeKey);
  useEffect(() => {
    if (pageSizePreference.key !== pageSizeKey) setPageSizePreference({ key: pageSizeKey, value: readIssuePageSize(pageSizeKey) });
  }, [pageSizeKey, pageSizePreference.key]);
  const setPageSize = (value: number) => {
    const size = normalizeIssuePageSize(value);
    setPageSizePreference({ key: pageSizeKey, value: size });
    try { localStorage.setItem(pageSizeKey, JSON.stringify(size)); }
    catch { notify("Rows per page updated for this visit, but browser storage is unavailable.", "error"); }
  };
  const resetKey = JSON.stringify([pageSizeKey, paginationKey, state]);
  const [paging, setPaging] = useState({ key: resetKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(issues.length / pageSize));
  const page = paging.key === resetKey ? Math.min(paging.page, pageCount - 1) : 0;
  useEffect(() => { setPaging({ key: resetKey, page }); }, [resetKey, page]);
  const [selection, setSelection] = useState<string[]>([]);
  const [sending, setSending] = useState<Issue[] | null>(null);
  const archivedProjects = new Set(projects?.filter((project) => project.archivedAt).map((project) => project.id));
  const eligible = new Set(readOnly ? [] : issues.filter((issue) => !issue.projectId || !archivedProjects.has(issue.projectId)).map((issue) => issue.id));
  const selected = selection.filter((id) => eligible.has(id));
  const selectedOpen = selected.filter((id) => issues.some((issue) => issue.id === id && issue.state === "open"));
  const eligibleKey = JSON.stringify([...eligible].sort());
  useEffect(() => { setSelection((ids) => ids.filter((id) => eligible.has(id))); }, [eligibleKey]);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const notify = useNotification();
  const rows = issues.slice(page * pageSize, (page + 1) * pageSize);
  const pageIds = rows.filter((issue) => eligible.has(issue.id)).map((issue) => issue.id);
  const checkedCount = pageIds.filter((id) => selected.includes(id)).length;
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headerCheckbox.current) headerCheckbox.current.indeterminate = checkedCount > 0 && checkedCount < pageIds.length; }, [checkedCount, pageIds.length]);
  const closeSelected = async () => {
    if (inFlight.current || readOnly || !selectedOpen.length) return;
    inFlight.current = true; setPending(true);
    const ids = [...selectedOpen];
    try {
      const result = await onCloseIssues(ids);
      const closed = new Set(result.closedIds.filter((id) => ids.includes(id)));
      setSelection((current) => current.filter((id) => !closed.has(id)));
      notify(result.error ? `${closed.size} of ${ids.length} issues closed. ${result.error}` : closed.size ? `${closed.size} ${closed.size === 1 ? "issue" : "issues"} closed.${closed.size < ids.length ? ` ${ids.length - closed.size} not closed.` : ""}` : "No issues closed.", result.error ? "error" : "success");
    } catch (error) { notify(`Could not close issues. ${error instanceof Error ? error.message : "Please try again."}`, "error"); }
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
  const visibleColumns = columnPreferences.filter(({ visible }) => visible).map(({ key }) => issueTableColumns.find((column) => column.key === key)!);
  const cellContent = (issue: Issue, key: IssueColumn) => {
    switch (key) {
      case "number": return <>!{issue.number}</>;
      case "state": return <IssueStateBadge state={issue.state} />;
      case "title": return <><Link ref={(node) => { if (node) links.current.set(issue.id, node); else links.current.delete(issue.id); }} data-issue-id={issue.id} className="issue-link" to={`/issues/${issue.id}`} onClick={(event) => { if (!event.altKey && !event.ctrlKey && !event.metaKey && event.button === 0) { activeId.current = issue.id; range.current = { key: orderKey, anchor: issue.id, base: [...selected] }; } onOpen(event, issue); }} aria-current={selectedId === issue.id ? "true" : undefined} aria-controls={controls} aria-label={`!${issue.number} ${issue.title}`}><strong>{issue.title}</strong></Link><ExternalLinks issue={issue} compact /></>;
      case "project": {
        const project = projects?.find((candidate) => candidate.id === issue.projectId);
        return issue.projectId ? project ? <Link to={`/projects/${project.slug}`}>{project.name}{project.archivedAt && <small className="muted"> (archived)</small>}</Link> : "Unknown project" : <span className="muted">No project</span>;
      }
      case "lane": {
        const lane = boardLanes.get(issue.id);
        return lane ? <span className="tag" title={`${lane.label}${lane.hidden ? " (hidden lane)" : ""}`}>{lane.label}{lane.hidden && <span className="muted"> (hidden)</span>}</span> : <span className="muted">Not on board</span>;
      }
      case "labels": return <div className="issue-meta">{issue.labels.length ? issue.labels.map((label) => <span className="tag" key={label} title={label}>{label}</span>) : empty("No tags")}</div>;
      case "tagged": return <div className="issue-meta">{issue.taggedUserIds.length ? issue.taggedUserIds.map((id) => { const user = users.find((candidate) => candidate.id === id); return <span className="tag user-tag" key={id} title={user?.email}>{user?.name || "Unknown user"}</span>; }) : empty("No tagged users")}</div>;
      case "creator": {
        const creator = users.find((user) => user.id === issue.authorId);
        return <span className={creator ? undefined : "muted"} title={creator?.email}>{creator?.name || "Unknown user"}</span>;
      }
      case "created": return <time dateTime={issue.createdAt} title={new Date(issue.createdAt).toLocaleString()}>{new Date(issue.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time>;
    }
  };
  const cellClasses: Partial<Record<IssueColumn, string>> = { number: "issue-number", project: "issue-project", lane: "issue-board-lane", creator: "issue-creator" };
  const fields: FilterFieldDefinition[] = [
    { key: "state", label: "State", options: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "draft", label: "Draft" }] },
    { key: "lane", label: "Board lane", valueLabel: "Filter by board lane", options: [{ value: "none", label: "Not on board" }, ...laneOptions] },
    { key: "title", label: "Issue", kind: "text", valueLabel: "Filter by issue" },
    { key: "number", label: "Number", kind: "number", valueLabel: "Filter by number" },
    { key: "labels", label: "Tags", valueLabel: "Filter by tag", options: [{ value: "none", label: "No tags" }, ...labels.map((label) => ({ value: `label:${label}`, label }))] },
    { key: "tagged", label: "Tagged users", valueLabel: "Filter by tagged user", options: [{ value: "none", label: "No tagged users" }, ...users.map((user) => ({ value: user.id, label: `${user.name} (${user.email})` }))] },
    { key: "creator", label: "Creator", valueLabel: "Filter by creator", options: [{ value: "unknown", label: "Unknown user" }, ...users.map((user) => ({ value: `user:${user.id}`, label: `${user.name} (${user.email})` }))] },
    { key: "created", label: "Created", kind: "date", fromLabel: "Created on or after", toLabel: "Created on or before" },
    ...(projects ? [{ key: "project" as const, label: "Project", valueLabel: "Filter by project", options: [{ value: "none", label: "No project" }, ...projects.map((project) => ({ value: project.id, label: `${project.name}${project.archivedAt ? " (archived)" : ""}` }))] }] : []),
  ];
  return <section className="issue-table-section" aria-label="Issue list">
    <section className="table-filters" aria-label="Table filters">
      <FilterBuilder fields={fields} value={state.filters} onChange={(filters) => patch({ filters })} />
    </section>
    <div className="issue-bulk-actions issue-table-actions" role="group" aria-label="Selected issue actions" aria-busy={pending}>
      <p className="issue-table-count muted">{issues.length} of {allIssues.length} issues</p>
      <Button ref={columnsButton} type="button" variant="secondary" aria-haspopup="dialog" onClick={() => setConfiguringColumns(true)}><Columns3 size={15} />Columns</Button>
      <span className="issue-selection-count">{selected.length} selected</span>
      {selected.length > 0 && <>
        <Button type="button" disabled={pending || readOnly || !selectedOpen.length} onClick={closeSelected}>{pending ? "Closing…" : "Close selected issues"}</Button>
        <Tooltip content="Mention user in selected issues"><Button type="button" disabled={pending || readOnly} onClick={() => onTagIssues([...selected])}>Mention</Button></Tooltip>
        <Tooltip content="Tag selected issues with labels"><Button type="button" disabled={pending || readOnly} onClick={() => onLabelIssues([...selected])}>Tag</Button></Tooltip>
        <Button type="button" disabled={pending || readOnly} onClick={() => setSending(issues.filter((issue) => selected.includes(issue.id)))}>Send to board</Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => { setSelection([]); range.current = null; }}>Clear selection</Button>
      </>}
    </div>
    {configuringColumns && <IssueColumnConfig columns={columnPreferences} includeProject={includeProject} onSave={saveColumns} onClose={closeColumnConfig} onRestoreFocus={() => columnsButton.current?.focus({ preventScroll: true })} />}
    {sending && <SendToBoardDialog issues={sending} onClose={() => setSending(null)}
      onPlaced={(projectId, board, issueIds) => {
        setSelection((current) => current.filter((id) => !issueIds.includes(id)));
        onBoardChanged(projectId, board);
      }} />}
    <div className="issue-table-scroll" tabIndex={0} role="region" aria-label="Scrollable issues table" onKeyDown={keyboardNavigate}>
      <table className={`issue-table${projects ? " all-issues-table" : ""}`} style={{ minWidth: 42 + visibleColumns.reduce((width, column) => width + column.width, 0) }}>
        <caption className="sr-only">Issues. Use column headings to sort and the filter bar to filter. Select issues to send to board lanes, add tags, mention teammates or close selected open issues. Up and Down open adjacent issues. Hold Shift with arrows or click to select a range.</caption>
        <colgroup><col className="selection-column" />{visibleColumns.map(({ key, className, width }) => <col key={key} className={className} style={{ width: key === "title" ? undefined : width }} />)}</colgroup>
        <thead><tr><th scope="col"><input ref={headerCheckbox} type="checkbox" aria-label="Select all issues on this page" checked={pageIds.length > 0 && checkedCount === pageIds.length} disabled={pending || !pageIds.length} onChange={(event) => { const checked = event.target.checked; range.current = null; setSelection((current) => checked ? [...new Set([...current, ...pageIds])] : current.filter((id) => !pageIds.includes(id))); }} /></th>
          {visibleColumns.map(({ key, label }) => <th key={key} scope="col" aria-sort={state.sort === key ? state.direction : "none"}><div className="issue-column-heading"><button type="button" className="column-sort" aria-label={`Sort by ${label.toLowerCase()}`} onClick={() => patch({ sort: key, direction: state.sort === key && state.direction === "ascending" ? "descending" : "ascending" })}>{label}{state.sort !== key ? <ArrowUpDown size={13} /> : state.direction === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button></div></th>)}
        </tr></thead>
        <tbody>{rows.map((issue) => <tr key={issue.id} onClickCapture={(event) => { if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).matches('input[type="checkbox"]')) return; event.preventDefault(); event.stopPropagation(); selectRange(issue.id); activeId.current = issue.id; links.current.get(issue.id)?.focus(); }} className={`issue-row${selectedId === issue.id ? " is-selected" : ""}${selected.includes(issue.id) ? " is-bulk-selected" : ""}`}>
          <td><input type="checkbox" aria-label={`Select issue !${issue.number}`} checked={selected.includes(issue.id)} disabled={pending || !eligible.has(issue.id)} onChange={(event) => { if ((event.nativeEvent as globalThis.MouseEvent).shiftKey) { selectRange(issue.id); activeId.current = issue.id; links.current.get(issue.id)?.focus(); return; } const checked = event.target.checked; activeId.current = issue.id; range.current = { key: orderKey, anchor: issue.id, base: selected.filter((id) => id !== issue.id) }; setSelection((current) => checked ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id)); }} /></td>
          {visibleColumns.map(({ key }) => <td key={key} data-column={key} className={cellClasses[key]}>{cellContent(issue, key)}</td>)}
        </tr>)}{!issues.length && <tr><td colSpan={visibleColumns.length + 1} className="table-empty">{allIssues.length ? "No matching issues. Adjust or clear your filters." : "No issues in this view."}</td></tr>}</tbody>
      </table>
    </div>
    <nav className="issue-pagination" aria-label="Issue list pagination"><label>Rows per page <select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPaging({ key: resetKey, page: 0 }); }}>{issuePageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label><span>{issues.length ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, issues.length)} of {issues.length}</span><span>Page {page + 1} of {pageCount}</span><Button type="button" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPaging({ key: resetKey, page: page - 1 })}>Previous</Button><Button type="button" variant="ghost" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPaging({ key: resetKey, page: page + 1 })}>Next</Button></nav>
  </section>;
}
