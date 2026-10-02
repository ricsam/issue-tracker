import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { STATUSES, type BoardSettings, type Issue } from "../../shared/types";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function BoardSettingsDialog({
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
  const [lanes, setLanes] = useState(settings.lanes);
  const [allIssues, setAllIssues] = useState(settings.issueIds === null);
  const [selected, setSelected] = useState(
    () => new Set(settings.issueIds ?? issues.map((issue) => issue.id)),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = issues.filter((issue) =>
    `${issue.number} ${issue.title} ${issue.labels.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lanes.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board`,
        {
          method: "PATCH",
          body: JSON.stringify({
            lanes: STATUSES.filter((status) =>
              lanes.includes(status.value),
            ).map((status) => status.value),
            issueIds: allIssues ? null : [...selected],
          }),
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
      title="Configure board"
      description="Choose the issues and status lanes for this project. Changes are shared with your team; the list view is unchanged."
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      className="board-settings-dialog"
    >
      <form className="form-stack" onSubmit={save}>
        <fieldset disabled={busy} className="board-settings-fields">
          <fieldset>
            <legend className="field-label">Visible lanes</legend>
            <div className="lane-options">
              {STATUSES.map((status) => (
                <label className="checkbox-option" key={status.value}>
                  <input
                    type="checkbox"
                    checked={lanes.includes(status.value)}
                    onChange={(event) =>
                      setLanes((current) =>
                        event.target.checked
                          ? [...current, status.value]
                          : current.filter((lane) => lane !== status.value),
                      )
                    }
                  />
                  <span className={`status-dot ${status.value}`} />
                  {status.label}
                </label>
              ))}
            </div>
            <p className="settings-help muted">
              Hiding a lane does not change issue statuses or remove issues from
              the board selection.
            </p>
            {!lanes.length && (
              <p className="error" role="alert">
                Select at least one lane.
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend className="field-label">Board issues</legend>
            <label className="checkbox-option">
              <input
                type="checkbox"
                checked={allIssues}
                onChange={(event) => setAllIssues(event.target.checked)}
              />
              Include all current and future issues
            </label>
            <p className="settings-help muted">
              {allIssues
                ? "Every project issue is included automatically. Turn this off to choose individual issues."
                : "Only selected issues are included. New issues can be added when you create them or here later."}
            </p>
            {!allIssues && (
              <>
                <div className="selection-toolbar">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search issues to add to board"
                      placeholder="Find issues by title, number, or label…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setSelected(new Set(issues.map((issue) => issue.id)))
                    }
                  >
                    Select all
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
                  {selected.size} of {issues.length} issues selected
                </p>
                <div className="board-issue-options">
                  {matches.map((issue) => (
                    <label
                      className="checkbox-option board-issue-option"
                      key={issue.id}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Include issue #${issue.number}: ${issue.title}`}
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
                      <span className="muted board-option-status">
                        {
                          STATUSES.find(
                            (status) => status.value === issue.status,
                          )?.label
                        }
                      </span>
                    </label>
                  ))}
                  {!matches.length && (
                    <p className="column-empty">
                      {issues.length
                        ? "No matching issues. Try another search."
                        : "No issues yet. Create an issue to add it to this board."}
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>
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
          <Button disabled={busy || !lanes.length}>
            {busy ? "Saving…" : "Save board"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
