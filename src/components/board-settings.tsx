import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import {
  LANES,
  type BoardLane,
  type BoardSettings,
  type Lane,
} from "../../shared/types";
import { moveLaneTo, orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import { Tooltip } from "./ui/tooltip";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

type Direction = "up" | "down";

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
  const [customLanes, setCustomLanes] = useState(settings.customLanes);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const idPrefix = useId();
  const refocus = useRef<{ lane: Lane; direction: Direction } | null>(null);
  const definitions = [...LANES, ...customLanes];
  const visible = orderedLanes(lanes, customLanes);
  const duplicate = definitions.some(
    (lane) => lane.label.toLowerCase() === name.trim().toLowerCase(),
  );
  const moveId = (lane: Lane, direction: Direction) =>
    `${idPrefix}-move-${direction}-${lane}`;

  // Reordering can detach the focused button from the document, so keep
  // keyboard focus on the moved lane's button. Edge buttons use aria-disabled
  // rather than disabled so focus stays put and repeated presses are no-ops.
  useLayoutEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    document.getElementById(moveId(target.lane, target.direction))?.focus();
  });

  function moveLane(lane: BoardLane, direction: Direction) {
    const index = lanes.indexOf(lane.value) + (direction === "up" ? -1 : 1);
    if (index < 0 || index >= lanes.length) return;
    refocus.current = { lane: lane.value, direction };
    setLanes(moveLaneTo(lanes, lane.value, index));
    setAnnouncement(
      `${lane.label} moved to position ${index + 1} of ${lanes.length}.`,
    );
  }

  function createLane() {
    if (!name.trim() || duplicate || customLanes.length >= 30 || busy) return;
    const lane = { value: `custom_${crypto.randomUUID()}`, label: name.trim() };
    setCustomLanes((current) => [...current, lane]);
    setLanes((current) => [...current, lane.value]);
    setName("");
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lanes.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board`,
        { method: "PATCH", body: JSON.stringify({ lanes, customLanes }) },
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
      title="Manage lanes"
      description="Reorder, add, remove, or create lanes for this board. Changes are shared with your team."
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      className="board-settings-dialog"
    >
      <form className="form-stack" onSubmit={save}>
        <fieldset disabled={busy} className="board-settings-fields">
          <legend className="field-label">Board lanes</legend>
          <ol className="lane-management-list">
            {visible.map((lane, index) => (
              <li className="lane-management-row" key={lane.value}>
                <span className={`lane-dot ${lane.value}`} />
                <span className="lane-name">{lane.label}</span>
                <span className="muted lane-issue-count">
                  {settings.cards.filter((card) => card.lane === lane.value).length} issues
                </span>
                <span className="lane-order-buttons">
                  <Tooltip content="Move up (further left on the board)"><button
                    type="button"
                    id={moveId(lane.value, "up")}
                    className="icon-button"
                    aria-label={`Move ${lane.label} lane up`}
                    aria-disabled={index === 0 || undefined}
                    onClick={() => moveLane(lane, "up")}
                  >
                    <ChevronUp size={16} />
                  </button></Tooltip>
                  <Tooltip content="Move down (further right on the board)"><button
                    type="button"
                    id={moveId(lane.value, "down")}
                    className="icon-button"
                    aria-label={`Move ${lane.label} lane down`}
                    aria-disabled={index === visible.length - 1 || undefined}
                    onClick={() => moveLane(lane, "down")}
                  >
                    <ChevronDown size={16} />
                  </button></Tooltip>
                </span>
                <Tooltip content={lanes.length === 1 ? "Keep at least one lane" : "Remove lane (keeps its issues)"}><button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${lane.label} lane`}
                  disabled={lanes.length === 1}
                  onClick={() => setLanes((current) => current.filter((value) => value !== lane.value))}
                >
                  <X size={16} />
                </button></Tooltip>
              </li>
            ))}
          </ol>
          <p className="sr-only" role="status">
            {announcement}
          </p>
          <p className="settings-help muted">
            The board shows lanes left to right in this order. Removed lanes
            keep their issues and can be added back below. Keep at least one
            lane.
          </p>
          {definitions.some((lane) => !lanes.includes(lane.value)) && (
            <section className="available-lanes" aria-label="Available lanes">
              <h3 className="field-label">Add an existing lane</h3>
              <div className="available-lane-buttons">
                {definitions.filter((lane) => !lanes.includes(lane.value)).map((lane) => (
                  <Button
                    key={lane.value}
                    type="button"
                    variant="secondary"
                    aria-label={`Add ${lane.label} lane`}
                    onClick={() => setLanes((current) => [...current, lane.value])}
                  >
                    <Plus size={14} /> {lane.label}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <div>
            <label htmlFor="new-lane-name">Create a new lane</label>
            <div className="new-lane-form">
              <input
                id="new-lane-name"
                placeholder="e.g. In review"
                maxLength={60}
                value={name}
                disabled={customLanes.length >= 30}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    createLane();
                  }
                }}
                aria-invalid={duplicate || undefined}
                aria-describedby={duplicate ? "lane-name-error" : undefined}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={createLane}
                disabled={!name.trim() || duplicate || customLanes.length >= 30}
              >
                <Plus size={15} /> Create lane
              </Button>
            </div>
            {duplicate && <p id="lane-name-error" className="settings-help" role="alert">A lane with this name already exists.</p>}
            {customLanes.length >= 30 && <p className="settings-help muted">This board has reached the limit of 30 custom lanes.</p>}
          </div>
        </fieldset>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
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
