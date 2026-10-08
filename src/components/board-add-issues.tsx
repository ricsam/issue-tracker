import { useId, useState, type FormEvent } from "react";
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
      .includes(query.toLowerCase()),
  );

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
      description="Choose work from the issue list and place it in a lane. New issues are never added automatically."
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
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!matches.length}
              onClick={() =>
                setSelected(
                  (current) =>
                    new Set([...current, ...matches.map((issue) => issue.id)]),
                )
              }
            >
              Select matching
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
          </div>
          <p className="settings-help muted" role="status">
            {selected.size} selected · {available.length} open issues not on
            board
          </p>
          <div className="board-issue-options">
            {matches.map((issue) => (
              <label
                className="checkbox-option board-issue-option"
                key={issue.id}
              >
                <input
                  type="checkbox"
                  aria-label={`Add issue #${issue.number}: ${issue.title}`}
                  checked={selected.has(issue.id)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(issue.id);
                      else next.delete(issue.id);
                      return next;
                    });
                  }}
                />
                <span className="issue-number">#{issue.number}</span>
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
