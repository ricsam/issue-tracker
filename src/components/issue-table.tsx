import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { Issue, User } from "../../shared/types";
import { hasColumnFilters, initialIssueTableState, type IssueColumn, type IssueTableState } from "../lib/issue-table";
import { Button } from "./ui/primitives";
import { ClosedTag } from "./lifecycle";

const columns: { key: IssueColumn; label: string }[] = [
  { key: "number", label: "Number" },
  { key: "title", label: "Issue" },
  { key: "labels", label: "Labels" },
  { key: "tagged", label: "Tagged users" },
  { key: "created", label: "Created" },
];

export function IssueTable({
  issues, allIssues, users, state, onChange, selectedId, controls, onOpen,
}: {
  issues: Issue[];
  allIssues: Issue[];
  users: User[];
  state: IssueTableState;
  onChange: (state: IssueTableState) => void;
  selectedId: string | null;
  controls?: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, issue: Issue) => void;
}) {
  const labels = [...new Set(allIssues.flatMap((issue) => issue.labels))].sort((a, b) => a.localeCompare(b));
  const patch = (value: Partial<IssueTableState>) => onChange({ ...state, ...value });
  const empty = (label: string) => <span className="muted empty-cell" aria-label={label}>—</span>;
  return (
    <section className="issue-table-section" aria-label="Issue list">
      <div className="issue-table-summary">
        <p className="muted">{issues.length} of {allIssues.length} issues</p>
        {hasColumnFilters(state) && (
          <Button type="button" variant="ghost" onClick={() => onChange({ ...initialIssueTableState, sort: state.sort, direction: state.direction })}>
            Clear column filters
          </Button>
        )}
      </div>
      <div className="issue-table-scroll" tabIndex={0} role="region" aria-label="Scrollable issues table">
        <table className="issue-table">
          <caption className="sr-only">Issues. Sort using column headings; combine filters below each heading.</caption>
          <colgroup>
            <col className="number-column" />
            <col className="title-column" />
            <col className="labels-column" />
            <col className="users-column" />
            <col className="date-column" />
          </colgroup>
          <thead>
            <tr>
              {columns.map(({ key, label }) => (
                <th key={key} scope="col" aria-sort={state.sort === key ? state.direction : "none"}>
                  <button
                    type="button"
                    className="column-sort"
                    aria-label={`Sort by ${label.toLowerCase()}`}
                    onClick={() => patch({ sort: key, direction: state.sort === key && state.direction === "ascending" ? "descending" : "ascending" })}
                  >
                    {label}
                    {state.sort !== key ? <ArrowUpDown size={13} /> : state.direction === "ascending" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  </button>
                </th>
              ))}
            </tr>
            <tr className="column-filters">
              <td><input aria-label="Filter by number" placeholder="#" inputMode="numeric" value={state.number} onChange={(e) => patch({ number: e.target.value })} /></td>
              <td><input aria-label="Filter by issue" placeholder="Filter title…" value={state.title} onChange={(e) => patch({ title: e.target.value })} /></td>
              <td>
                <select aria-label="Filter by label" value={state.label} onChange={(e) => patch({ label: e.target.value })}>
                  <option value="">All labels</option>
                  <option value="none">No labels</option>
                  {labels.map((label) => <option key={label} value={`label:${label}`}>{label}</option>)}
                </select>
              </td>
              <td>
                <select aria-label="Filter by tagged user" value={state.tagged} onChange={(e) => patch({ tagged: e.target.value })}>
                  <option value="">Anyone</option>
                  <option value="none">No tagged users</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
                </select>
              </td>
              <td>
                <div className="date-filter">
                  <label><span>From</span><input type="date" aria-label="Created on or after" value={state.createdFrom} max={state.createdTo || undefined} onChange={(e) => patch({ createdFrom: e.target.value })} /></label>
                  <label><span>To</span><input type="date" aria-label="Created on or before" value={state.createdTo} min={state.createdFrom || undefined} onChange={(e) => patch({ createdTo: e.target.value })} /></label>
                </div>
              </td>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={issue.id} className={`issue-row${selectedId === issue.id ? " is-selected" : ""}`}>
                <td className="issue-number">#{issue.number}</td>
                <td>
                  <Link
                    className="issue-link"
                    to={`/issues/${issue.id}`}
                    onClick={(event) => onOpen(event, issue)}
                    aria-current={selectedId === issue.id ? "true" : undefined}
                    aria-controls={controls}
                    aria-label={`#${issue.number} ${issue.title}`}
                  >
                    <strong>{issue.title}</strong>
                    {issue.state === "closed" && <ClosedTag />}
                  </Link>
                </td>
                <td><div className="issue-meta">{issue.labels.length ? issue.labels.map((label) => <span className="tag" key={label} title={label}>{label}</span>) : empty("No labels")}</div></td>
                <td><div className="issue-meta">{issue.taggedUserIds.length ? issue.taggedUserIds.map((id) => {
                  const user = users.find((candidate) => candidate.id === id);
                  return <span className="tag user-tag" key={id} title={user?.email}>{user?.name || "Unknown user"}</span>;
                }) : empty("No tagged users")}</div></td>
                <td><time dateTime={issue.createdAt} title={new Date(issue.createdAt).toLocaleString()}>{new Date(issue.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time></td>
              </tr>
            ))}
            {!issues.length && (
              <tr><td colSpan={5} className="table-empty">{allIssues.length ? "No matching issues. Adjust or clear your filters." : "No issues in this view."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
