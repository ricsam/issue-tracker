import { useCallback, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import type { IssueHistoryEntry } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice } from "./ui/primitives";
import "./issue-history.css";

const actions: Record<IssueHistoryEntry["action"], string> = {
  created: "created this issue",
  updated: "updated this issue",
  commented: "added a comment",
  comment_edited: "edited a comment",
  comment_deleted: "deleted a comment",
};
const fields = { body: "Body", state: "State", project: "Project", boardLane: "Board lane", comment: "Comment" };
function displayValue(field: IssueHistoryEntry["changes"][number]["field"], value: string | null) {
  if (value === null) return field === "project" ? "No project" : field === "boardLane" ? "Not on board" : "None";
  if (field === "state") return value === "closed" ? "Closed" : "Open";
  return value || "(empty)";
}

export function IssueHistory({ issueId, revision }: { issueId: string; revision: number }) {
  const { users } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<IssueHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (before?: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ history: IssueHistoryEntry[]; hasMore: boolean }>(
        `/api/issues/${issueId}/history?limit=50${before === undefined ? "" : `&before=${before}`}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setHistory((current) => before === undefined ? result.history : [...current, ...result.history]);
      setHasMore(result.hasMore);
      setLoaded(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [issueId]);
  useEffect(() => {
    if (open) void load();
    return () => request.current?.abort();
  }, [open, revision, load]);
  return <details className="issue-history" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><History size={17} aria-hidden="true" /> Change history</summary>
    {open && <div className="issue-history-content" aria-busy={loading}>
      <div className="issue-history-heading">
        <p className="muted">Newest first. Changes made before history tracking was introduced are not available.</p>
        <Button type="button" variant="ghost" disabled={loading} onClick={() => void load()}>{error ? "Retry history" : "Refresh history"}</Button>
      </div>
      <ErrorNotice error={error ? `Could not load history: ${error}` : ""} />
      {loading && <p role="status" className="muted">Loading history…</p>}
      {loaded && !loading && !error && !history.length && <p className="muted">No recorded changes yet.</p>}
      <ol className="issue-history-list">
        {history.map((entry) => <li key={entry.id}>
          <div className="issue-history-meta"><span><strong>{users.find((user) => user.id === entry.actorId)?.name || "A teammate"}</strong> {actions[entry.action]}</span>
            <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></div>
          <ul className="issue-history-changes">{entry.changes.map((change, index) => <li key={`${change.field}-${index}`}>
            {change.field === "body" || change.field === "comment" ? <details>
              <summary>{fields[change.field]} {change.before === null ? "added" : change.after === null ? "removed" : "changed"}</summary>
              <div className="issue-history-snapshots">
                {change.before !== null && <div><strong>Before</strong><pre>{displayValue(change.field, change.before)}</pre></div>}
                {change.after !== null && <div><strong>After</strong><pre>{displayValue(change.field, change.after)}</pre></div>}
              </div>
            </details> : <span><strong>{fields[change.field]}:</strong> {displayValue(change.field, change.before)} <span aria-label="changed to">→</span> {displayValue(change.field, change.after)}</span>}
          </li>)}</ul>
        </li>)}
      </ol>
      {hasMore && <Button type="button" variant="secondary" disabled={loading} onClick={() => void load(history.at(-1)?.id)}>Load older changes</Button>}
    </div>}
  </details>;
}
