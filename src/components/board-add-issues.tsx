import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import {
  type BoardSettings,
  type Issue,
  type Lane,
} from "../../shared/types";
import { orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function BoardAddIssuesDialog({
  slug,
  settings,
  issues,
  onSaved,
  onClose,
}: {
  slug: string;
  settings: BoardSettings;
  issues: Issue[];
  onSaved: (settings: BoardSettings) => void;
  onClose: () => void;
}) {
  const laneId = useId();
  const [lane, setLane] = useState<Lane>(settings.lanes[0]);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [query, setQuery] = useState("");
  const anchor = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const placed = new Set(settings.cards.map((card) => card.issueId));
  // Boards plan open work; a closed issue must be reopened before it is added.
  const available = issues.filter(
    (issue) => !placed.has(issue.id) && issue.state === "open",
  );
  const matches = available.filter((issue) =>
    `${issue.number} ${issue.title} ${issue.labels.join(" ")}`
      .toLowerCase()
      .includes(query.trim().replace(/^!(?=\d)/, "").toLowerCase()),
  );

  const availableKey = available.map((issue) => issue.id).join(",");
  useEffect(() => {
    const valid = new Set(available.map((issue) => issue.id));
    setSelected((current) => new Set([...current].filter((id) => valid.has(id))));
    if (anchor.current && !valid.has(anchor.current)) anchor.current = null;
  }, [availableKey]);
  const allMatching = matches.length > 0 && matches.every((issue) => selected.has(issue.id));
  const someMatching = matches.some((issue) => selected.has(issue.id));
  function selectIssue(id: string, checked: boolean, shift: boolean) {
    const start = matches.findIndex((issue) => issue.id === anchor.current);
    const end = matches.findIndex((issue) => issue.id === id);
    const ids = shift && start >= 0 && end >= 0
      ? matches.slice(Math.min(start, end), Math.max(start, end) + 1).map((issue) => issue.id)
      : [id];
    setSelected((current) => {
      const next = new Set(current);
      for (const issueId of ids) checked ? next.add(issueId) : next.delete(issueId);
      return next;
    });
    if (!shift || start < 0) anchor.current = id;
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected.size || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board/issues`,
        {
          method: "POST",
          body: JSON.stringify({ issueIds: [...selected], lane }),
        },
      );
      onSaved(result.board);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add issues to board"
      description="Choose open issues and place them in a lane. Shift-click to select a range."
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      className="board-settings-dialog"
    >
      <form className="form-stack" onSubmit={add}>
        <fieldset disabled={busy} className="board-settings-fields">
          <div>
            <label htmlFor={laneId}>Lane</label>
            <select
              id={laneId}
              value={lane}
              onChange={(event) => setLane(event.target.value as Lane)}
            >
              {orderedLanes(settings.lanes, settings.customLanes).map(
                (item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="selection-toolbar">
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search issues to add to board"
                placeholder="Find issues by title, number, or tag…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); anchor.current = null; }}
              />
            </div>
          </div>
          <p className="settings-help muted" role="status">
            {selected.size} selected · {available.length} open issues not on
            board
          </p>
          <div className="board-issue-options">
            <label className="checkbox-option board-issue-option board-select-all">
              <input type="checkbox" aria-label="Select all matching issues"
                checked={allMatching}
                ref={(element) => { if (element) element.indeterminate = someMatching && !allMatching; }}
                disabled={!matches.length}
                onChange={(event) => {
                  const checked = event.target.checked;
                  anchor.current = null;
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const issue of matches) checked ? next.add(issue.id) : next.delete(issue.id);
                    return next;
                  });
                }} />
              <span>Select all matching issues</span>
              <span className="muted">({matches.length})</span>
            </label>
            {matches.map((issue) => (
              <label
                className="checkbox-option board-issue-option"
                key={issue.id}
              >
                <input
                  type="checkbox"
                  aria-label={`Add issue !${issue.number}: ${issue.title}`}
                  checked={selected.has(issue.id)}
                  onChange={(event) => selectIssue(issue.id, event.target.checked, (event.nativeEvent as MouseEvent).shiftKey)}
                />
                <span className="issue-number">!{issue.number}</span>
                <span className="board-option-title">{issue.title}</span>
              </label>
            ))}
            {!matches.length && (
              <p className="column-empty">
                {available.length
                  ? "No matching issues. Try another search."
                  : !issues.length
                    ? "No issues yet. Create an issue first, then add it here."
                    : issues.some((issue) => issue.state === "open")
                      ? "All open issues are already on the board."
                      : "No open issues to add. Reopen an issue to plan it again."}
              </p>
            )}
          </div>
        </fieldset>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || !selected.size}>
            {busy ? "Adding…" : "Add to board"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
