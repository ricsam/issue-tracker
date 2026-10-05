import { useState, type FormEvent } from "react";
import { LANES, type BoardSettings } from "../../shared/types";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function BoardSettingsDialog({
  slug,
  settings,
  onSaved,
  onClose,
}: {
  slug: string;
  settings: BoardSettings;
  onSaved: (settings: BoardSettings) => void;
  onClose: () => void;
}) {
  const [lanes, setLanes] = useState(settings.lanes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lanes.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board`,
        { method: "PATCH", body: JSON.stringify({ lanes }) },
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
      description="Choose the lanes shown on this board. Changes are shared with your team."
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      className="board-settings-dialog"
    >
      <form className="form-stack" onSubmit={save}>
        <fieldset disabled={busy} className="board-settings-fields">
          <legend className="field-label">Visible lanes</legend>
          <div className="lane-options">
            {LANES.map((lane) => (
              <label className="checkbox-option" key={lane.value}>
                <input
                  type="checkbox"
                  checked={lanes.includes(lane.value)}
                  onChange={(event) =>
                    setLanes((current) =>
                      event.target.checked
                        ? [...current, lane.value]
                        : current.filter((value) => value !== lane.value),
                    )
                  }
                />
                <span className={`lane-dot ${lane.value}`} />
                {lane.label}
              </label>
            ))}
          </div>
          <p className="settings-help muted">
            Hiding a lane keeps its issues on the board. Show it again to move
            or remove them. Use Add issues to bring work onto the board.
          </p>
          {!lanes.length && (
            <p className="error" role="alert">
              Select at least one lane.
            </p>
          )}
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
