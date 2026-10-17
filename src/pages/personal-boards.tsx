import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LockKeyhole, Plus, Columns3 } from "lucide-react";
import { LANES, type BoardSettings, type Issue } from "../../shared/types";
import { moveLaneTo, orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import {
  issuePath,
  useWorkspace,
  useWorkspaceDraftGuard,
  workspacePath,
} from "../lib/workspace";
import {
  defaultIssueFilters,
  matchesIssueFilters,
  normalizeIssueFilters,
} from "../lib/issue-filters";
import { boardLaneOptions, issueBoardLanes } from "../lib/issue-board-lanes";
import {
  boardConfig,
  personalLane,
  removePersonalLane,
  PersonalBoardSaveQueue,
  type PersonalBoard,
  type PersonalBoardConfig,
  type SaveState,
} from "../lib/personal-boards";
import {
  FilterBuilder,
  type FilterFieldDefinition,
} from "../components/filter-builder";
import {
  Button,
  ErrorNotice,
  Loading,
  Modal,
} from "../components/ui/primitives";
import "./personal-boards.css";

const scoped = (slug: string): RequestInit => ({
  headers: { "X-Workspace-Slug": slug },
});
const endpoint = (id: string) => `/api/me/boards/${encodeURIComponent(id)}`;
const privateNote = (
  <span className="personal-private">
    <LockKeyhole size={14} /> Only you · This workspace
  </span>
);

export function PersonalBoardsPage() {
  const { workspace } = useWorkspace();
  return workspace ? (
    <PersonalBoardsList key={workspace.id} slug={workspace.slug} />
  ) : (
    <p>Select a workspace to view your personal boards.</p>
  );
}
function PersonalBoardsList({ slug }: { slug: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [seed, setSeed] = useState(
    location.state as {
      create?: boolean;
      filters?: unknown;
      search?: string;
    } | null,
  );
  const [boards, setBoards] = useState<PersonalBoard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(!!seed?.create);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    let active = true;
    alive.current = true;
    void api<{ boards: PersonalBoard[] }>("/api/me/boards", scoped(slug))
      .then((data) => {
        if (active) {
          setBoards(data.boards);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setLoaded(true);
        }
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [slug]);
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { board } = await api<{ board: PersonalBoard }>("/api/me/boards", {
        ...scoped(slug),
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(seed?.create
            ? {
                filters: normalizeIssueFilters(seed.filters),
                search: seed.search || "",
              }
            : { filters: defaultIssueFilters }),
        }),
      });
      if (alive.current) navigate(workspacePath(slug, `/boards/${board.id}`));
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="personal-boards-page">
      <header className="personal-heading">
        <div>
          <h1>Personal boards</h1>
          <p className="muted">
            Your issues, organized your way. Save filters and arrange private
            lanes without changing project boards.
          </p>
          {privateNote}
        </div>
        <Button
          onClick={() => {
            setSeed(null);
            setName("");
            setCreating(true);
          }}
        >
          <Plus size={16} /> Create personal board
        </Button>
      </header>
      <ErrorNotice error={error} />
      {!loaded ? (
        <Loading />
      ) : error && !boards.length ? (
        <Button onClick={() => window.location.reload()}>
          Retry loading boards
        </Button>
      ) : (
        <div className="personal-board-grid">
          {boards.map((board) => (
            <Link
              className="personal-board-tile"
              key={board.id}
              to={workspacePath(slug, `/boards/${board.id}`)}
            >
              <Columns3 size={24} />
              <h2>{board.name}</h2>
              <p>
                {board.lanes.length} lanes · {board.filters.conditions.length}{" "}
                filters
              </p>
              <span>Open board →</span>
            </Link>
          ))}
          {!boards.length && (
            <div className="personal-empty">
              <Columns3 size={32} />
              <h2>A space for your focus</h2>
              <p>
                Combine issues across projects, filter by tagged users, and keep
                your own workflow.
              </p>
            </div>
          )}
        </div>
      )}
      <Modal
        title="Create personal board"
        description="Private to your account in this workspace. Filters and layout save automatically."
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            Board name
            <input
              autoFocus
              aria-label="Board name"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ErrorNotice error={error} />
          <div className="personal-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create board"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function PersonalBoardPage() {
  const { workspace } = useWorkspace();
  const { boardId } = useParams();
  return workspace && boardId ? (
    <PersonalBoardView
      key={`${workspace.id}:${boardId}`}
      slug={workspace.slug}
      boardId={boardId}
    />
  ) : (
    <p>Select a personal board.</p>
  );
}
function PersonalBoardView({
  slug,
  boardId,
}: {
  slug: string;
  boardId: string;
}) {
  const { users, projects } = useWorkspace();
  const navigate = useNavigate();
  const [board, setBoard] = useState<PersonalBoard | null>(null);
  const current = useRef<PersonalBoard | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projectBoards, setProjectBoards] = useState<
    Record<string, BoardSettings>
  >({});
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [settings, setSettings] = useState(false);
  const [laneName, setLaneName] = useState("");
  const [laneError, setLaneError] = useState("");
  const [rename, setRename] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const queue = useRef<PersonalBoardSaveQueue | null>(null);
  const alive = useRef(true);
  useWorkspaceDraftGuard(saveState !== "saved");
  useEffect(() => {
    let active = true;
    alive.current = true;
    const read = async () =>
      (await api<{ board: PersonalBoard }>(endpoint(boardId), scoped(slug)))
        .board;
    void Promise.all([
      read(),
      api<{ issues: Issue[]; boards: Record<string, BoardSettings> }>(
        "/api/issues",
        scoped(slug),
      ),
    ])
      .then(([saved, data]) => {
        if (!active) return;
        current.current = saved;
        setBoard(saved);
        setIssues(data.issues);
        setProjectBoards(data.boards);
        queue.current = new PersonalBoardSaveQueue(
          saved,
          async (config, revision) =>
            (
              await api<{ board: PersonalBoard }>(endpoint(boardId), {
                ...scoped(slug),
                method: "PATCH",
                body: JSON.stringify({ ...config, revision }),
              })
            ).board,
          read,
          (state, text = "") => {
            if (active) {
              setSaveState(state);
              setSaveError(text);
            }
          },
        );
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
      alive.current = false;
      queue.current?.dispose();
    };
  }, [slug, boardId]);
  useEffect(() => {
    if (saveState === "saved") return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);
  useEffect(() => {
    if (saveState === "saved") return;
    const confirmLeave = () =>
      window.confirm(
        "Some personal board changes are not saved. Discard unsaved changes and leave? A save already in progress may still complete.",
      );
    const click = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !link ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        link.target === "_blank" ||
        link.href === window.location.href
      )
        return;
      if (!confirmLeave()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // BrowserRouter listens to popstate. Capture before it handles the event;
    // rejected back/forward moves are restored without unmounting this editor.
    const index = window.history.state?.idx;
    let restoring = false;
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      if (confirmLeave()) return;
      const target = event.state?.idx;
      if (
        typeof index === "number" &&
        typeof target === "number" &&
        index !== target
      ) {
        event.stopImmediatePropagation();
        restoring = true;
        window.history.go(index - target);
      }
    };
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop, true);
    };
  }, [saveState]);
  function update(patch: Partial<PersonalBoardConfig>) {
    if (!current.current) return;
    const next = { ...current.current, ...patch };
    current.current = next;
    setBoard(next);
    queue.current?.update(boardConfig(next));
  }
  async function refreshIssues() {
    setError("");
    try {
      const data = await api<{
        issues: Issue[];
        boards: Record<string, BoardSettings>;
      }>("/api/issues", scoped(slug));
      if (alive.current) {
        setIssues(data.issues);
        setProjectBoards(data.boards);
      }
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }
  async function removeBoard() {
    setBusy(true);
    setError("");
    try {
      await api(endpoint(boardId), { ...scoped(slug), method: "DELETE" });
      if (alive.current) navigate(workspacePath(slug, "/boards"));
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!board)
    return error ? (
      <div className="personal-boards-page">
        <ErrorNotice error={error} />
        <Button onClick={() => window.location.reload()}>Retry loading</Button>
      </div>
    ) : (
      <Loading />
    );
  const lanes = orderedLanes(board.lanes, board.customLanes, board.laneLabels);
  const definitions = orderedLanes([...LANES, ...board.customLanes].map((lane) => lane.value), board.customLanes, board.laneLabels);
  const sourceLanes = issueBoardLanes(projectBoards);
  const fields: FilterFieldDefinition[] = [
    {
      key: "state",
      label: "State",
      options: ["open", "closed", "draft"].map((value) => ({
        value,
        label: value[0].toUpperCase() + value.slice(1),
      })),
    },
    {
      key: "project",
      label: "Project",
      options: [
        { value: "none", label: "No project" },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ],
    },
    {
      key: "tagged",
      label: "Tagged users",
      options: [
        { value: "none", label: "No tagged users" },
        ...users.map((u) => ({ value: u.id, label: u.name })),
      ],
    },
    {
      key: "labels",
      label: "Tags",
      options: [
        { value: "none", label: "No tags" },
        ...[...new Set(issues.flatMap((i) => i.labels))]
          .sort()
          .map((label) => ({ value: `label:${label}`, label })),
      ],
    },
    {
      key: "creator",
      label: "Creator",
      options: [
        { value: "unknown", label: "Unknown creator" },
        ...users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
      ],
    },
    {
      key: "lane",
      label: "Project board lane",
      options: [
        { value: "none", label: "No board lane" },
        ...boardLaneOptions(projectBoards, projects, true),
      ],
    },
    { key: "title", label: "Issue", kind: "text" },
    { key: "number", label: "Number", kind: "number" },
    { key: "created", label: "Created", kind: "date" },
  ];
  const matching = issues.filter(
    (issue) =>
      matchesIssueFilters(issue, board.filters, {
        users,
        lane: sourceLanes.get(issue.id)?.value,
      }) &&
      `${issue.title} ${issue.number} ${issue.labels.join(" ")} ${users
        .filter((user) => issue.taggedUserIds.includes(user.id))
        .map((user) => user.name)
        .join(" ")}`
        .toLowerCase()
        .includes(
          board.search
            .trim()
            .replace(/^!(?=\d)/, "")
            .toLowerCase(),
        ),
  );
  const rank = new Map(board.cards.map((card, index) => [card.issueId, index]));
  matching.sort(
    (a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
      b.number - a.number,
  );
  const moveCard = (issueId: string, lane: string, before?: string) => {
    const cards = matching.map((issue) => ({
      issueId: issue.id,
      lane: personalLane(issue, board)!,
    }));
    const all = [
      ...board.cards.filter(
        (card) => !cards.some((item) => item.issueId === card.issueId),
      ),
      ...cards,
    ].filter((card) => card.issueId !== issueId);
    const index = before
      ? all.findIndex((card) => card.issueId === before)
      : -1;
    all.splice(index < 0 ? all.length : index, 0, { issueId, lane });
    update({ cards: all });
  };
  const locked = saveState === "conflict" || busy;
  return (
    <div className="personal-boards-page">
      <Link to={workspacePath(slug, "/boards")}>← Personal boards</Link>
      <header className="personal-heading">
        <div>
          <h1>{board.name}</h1>
          {privateNote}
        </div>
        <div className="personal-actions">
          <span
            role="status"
            className={`personal-save personal-save-${saveState}`}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "All changes saved"
                : "Changes not saved"}
          </span>
          <Button
            variant="secondary"
            onClick={() => setSettings(!settings)}
            aria-expanded={settings}
          >
            Manage lanes
          </Button>
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => {
              setName(board.name);
              setRename(true);
            }}
          >
            Rename board
          </Button>
          <Button
            variant="ghost"
            disabled={saveState !== "saved" || busy}
            onClick={() => setDeleting(true)}
          >
            Delete board
          </Button>
        </div>
      </header>
      <ErrorNotice error={error || saveError} />
      {(saveState === "error" || saveState === "conflict") && (
        <div className="personal-actions">
          {saveState === "error" && (
            <Button onClick={() => void queue.current?.retry()}>
              Retry saving
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              if (
                window.confirm(
                  "Discard unsaved changes and reload the saved board?",
                )
              )
                window.location.reload();
            }}
          >
            Reload saved version
          </Button>
        </div>
      )}
      <div className="personal-filter-bar">
        <input
          type="search"
          aria-label="Search personal board"
          placeholder="Search issues…"
          value={board.search}
          maxLength={1000}
          disabled={locked}
          onChange={(event) => update({ search: event.target.value })}
        />
        <span className="muted">
          {matching.length} matching issues · placements are private
        </span>
        <Button variant="secondary" onClick={() => void refreshIssues()}>
          Refresh issues
        </Button>
      </div>
      <p className="muted">
        Project board lane filters use shared project placement. Moving cards
        here changes only your private placement.
      </p>
      <section aria-label="Personal board filters">
        <FilterBuilder
          fields={fields}
          value={board.filters}
          disabled={locked}
          onChange={(filters) => update({ filters })}
        />
      </section>
      {settings && (
        <section
          className="personal-lane-settings"
          aria-label="Manage personal lanes"
        >
          <h2>Your lanes</h2>
          <p className="muted">
            Changes save automatically. Hiding or removing a lane never removes
            its issues.
          </p>
          <ErrorNotice error={laneError} />
          {lanes.map((lane, index) => (
            <div className="personal-lane-setting" key={lane.value}>
              <input
                aria-label={`Name for ${lane.label}`}
                defaultValue={lane.label}
                key={`${lane.value}:${lane.label}`}
                maxLength={60}
                disabled={locked}
                onBlur={(event) => {
                  const label = event.target.value.trim();
                  if (
                    !label ||
                    definitions.some(
                      (item) =>
                        item.value !== lane.value &&
                        item.label.toLowerCase() === label.toLowerCase(),
                    )
                  ) {
                    setLaneError("Lane names must be nonempty and unique.");
                    event.target.value = lane.label;
                    return;
                  }
                  setLaneError("");
                  if (label !== lane.label)
                    update({
                      laneLabels: { ...board.laneLabels, [lane.value]: label },
                    });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <Button
                variant="ghost"
                aria-label={`Move ${lane.label} earlier`}
                disabled={locked || index === 0}
                onClick={() =>
                  update({
                    lanes: moveLaneTo(board.lanes, lane.value, index - 1),
                  })
                }
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                aria-label={`Move ${lane.label} later`}
                disabled={locked || index === lanes.length - 1}
                onClick={() =>
                  update({
                    lanes: moveLaneTo(board.lanes, lane.value, index + 1),
                  })
                }
              >
                ↓
              </Button>
              <label>
                <input
                  type="checkbox"
                  checked={board.hiddenLanes.includes(lane.value)}
                  disabled={
                    locked ||
                    (!board.hiddenLanes.includes(lane.value) &&
                      lanes.filter(
                        (item) => !board.hiddenLanes.includes(item.value),
                      ).length <= 1)
                  }
                  onChange={(event) =>
                    update({
                      hiddenLanes: event.target.checked
                        ? [...board.hiddenLanes, lane.value]
                        : board.hiddenLanes.filter(
                            (value) => value !== lane.value,
                          ),
                    })
                  }
                />{" "}
                Hide
              </label>
              <Button
                variant="ghost"
                disabled={locked || lanes.length <= 1}
                aria-label={`Remove ${lane.label} lane`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${lane.label}? Its issues will move to the first remaining lane.`,
                    )
                  )
                    update(removePersonalLane(board, lane.value));
                }}
              >
                Remove
              </Button>
            </div>
          ))}
          {definitions.some((lane) => !board.lanes.includes(lane.value)) && <div className="personal-actions">
            <span className="muted">Restore an existing lane:</span>
            {definitions.filter((lane) => !board.lanes.includes(lane.value)).map((lane) => <Button key={lane.value} variant="secondary" disabled={locked}
              onClick={() => update({ lanes: [...board.lanes, lane.value] })}>Restore {lane.label} lane</Button>)}
          </div>}
          <form
            className="personal-actions"
            onSubmit={(event) => {
              event.preventDefault();
              if (locked || board.customLanes.length >= 30) return;
              const label = laneName.trim();
              if (
                !label ||
                definitions.some(
                  (lane) => lane.label.toLowerCase() === label.toLowerCase(),
                )
              ) {
                setLaneError("Choose a unique lane name.");
                return;
              }
              const lane = { value: `custom_${crypto.randomUUID()}`, label };
              update({
                lanes: [...board.lanes, lane.value],
                customLanes: [...board.customLanes, lane],
              });
              setLaneName("");
              setLaneError("");
            }}
          >
            <input
              aria-label="New lane name"
              placeholder="New lane name"
              maxLength={60}
              value={laneName}
              disabled={locked || board.customLanes.length >= 30}
              onChange={(event) => setLaneName(event.target.value)}
            />
            <Button
              disabled={
                locked || !laneName.trim() || board.customLanes.length >= 30
              }
            >
              Add lane
            </Button>
          </form>
        </section>
      )}
      {board.hiddenLanes.length > 0 && (
        <p className="muted">
          {board.hiddenLanes.length} hidden lanes{" "}
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => update({ hiddenLanes: [] })}
          >
            Show all lanes
          </Button>
        </p>
      )}
      {!matching.length && (
        <p className="personal-empty">
          No matching issues. Adjust your filters or search to broaden this
          view.
        </p>
      )}
      <div className="personal-lanes" aria-label="Personal board lanes">
        {lanes
          .filter((lane) => !board.hiddenLanes.includes(lane.value))
          .map((lane) => {
            const cards = matching.filter(
              (issue) => personalLane(issue, board) === lane.value,
            );
            const collapsed = board.collapsedLanes.includes(lane.value);
            return (
              <section
                key={lane.value}
                className="personal-lane"
                aria-label={`${lane.label} lane`}
                onDragOver={(event) => {
                  if (!locked) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData(
                    "application/x-personal-issue",
                  );
                  if (!locked && matching.some((issue) => issue.id === id))
                    moveCard(id, lane.value);
                }}
              >
                <header>
                  <h2>
                    {lane.label} <span>{cards.length}</span>
                  </h2>
                  <Button
                    variant="ghost"
                    disabled={locked}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${lane.label}`}
                    aria-expanded={!collapsed}
                    onClick={() =>
                      update({
                        collapsedLanes: collapsed
                          ? board.collapsedLanes.filter(
                              (value) => value !== lane.value,
                            )
                          : [...board.collapsedLanes, lane.value],
                      })
                    }
                  >
                    {collapsed ? "+" : "−"}
                  </Button>
                </header>
                {!collapsed && (
                  <div className="personal-cards">
                    {cards.map((issue, index) => (
                      <article
                        className="personal-card"
                        key={issue.id}
                        draggable={!locked}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(
                            "application/x-personal-issue",
                            issue.id,
                          );
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(event) => {
                          if (!locked) event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const id = event.dataTransfer.getData(
                            "application/x-personal-issue",
                          );
                          if (
                            !locked &&
                            id !== issue.id &&
                            matching.some((item) => item.id === id)
                          )
                            moveCard(id, lane.value, issue.id);
                        }}
                      >
                        <div className="personal-card-meta">
                          <span>
                            !{issue.number} · {issue.state}
                          </span>
                          <span>
                            {projects.find((p) => p.id === issue.projectId)
                              ?.name || "No project"}
                          </span>
                        </div>
                        <Link to={issuePath(issue)}>{issue.title}</Link>
                        {!!issue.labels.length && (
                          <div className="personal-tags">
                            {issue.labels.map((label) => (
                              <span key={label}>#{label}</span>
                            ))}
                          </div>
                        )}
                        <div className="personal-card-controls">
                          <select
                            aria-label={`Move issue ${issue.number} to lane`}
                            value={lane.value}
                            disabled={locked}
                            onChange={(event) =>
                              moveCard(issue.id, event.target.value)
                            }
                          >
                            {lanes.map((item) => (
                              <option key={item.value} value={item.value}>
                                {item.label}
                                {board.hiddenLanes.includes(item.value)
                                  ? " (hidden)"
                                  : ""}
                              </option>
                            ))}
                          </select>
                          <Button
                            variant="ghost"
                            aria-label={`Move issue ${issue.number} earlier`}
                            disabled={locked || index === 0}
                            onClick={() =>
                              moveCard(
                                issue.id,
                                lane.value,
                                cards[index - 1].id,
                              )
                            }
                          >
                            ↑
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={`Move issue ${issue.number} later`}
                            disabled={locked || index === cards.length - 1}
                            onClick={() =>
                              moveCard(
                                issue.id,
                                lane.value,
                                cards[index + 2]?.id,
                              )
                            }
                          >
                            ↓
                          </Button>
                        </div>
                      </article>
                    ))}
                    {!cards.length && (
                      <p className="muted personal-lane-empty">
                        No issues here yet
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
      </div>
      <Modal
        title="Rename personal board"
        open={rename}
        onOpenChange={setRename}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) {
              update({ name: name.trim() });
              setRename(false);
            }
          }}
        >
          <label>
            Board name
            <input
              autoFocus
              aria-label="Board name"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="muted">
            The new name will save automatically after confirmation.
          </p>
          <div className="personal-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setRename(false)}
            >
              Cancel
            </Button>
            <Button disabled={!name.trim()}>Confirm rename</Button>
          </div>
        </form>
      </Modal>
      <Modal
        title="Delete personal board?"
        description="This removes only your saved view and private placement. No issues or project boards will be deleted."
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <ErrorNotice error={error} />
        <div className="personal-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setDeleting(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void removeBoard()}>
            {busy ? "Deleting…" : "Confirm delete"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
