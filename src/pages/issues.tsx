import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Columns3,
  List,
  Plus,
  Search,
  Inbox,
  GripVertical,
  SlidersHorizontal,
  Maximize2,
  X,
} from "lucide-react";
import {
  LANES,
  type Issue,
  type Project,
  type Lane,
  type BoardSettings,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { parseLabels, validateIssueBody } from "../lib/validation";
import { useWorkspace } from "../lib/workspace";
import {
  Button,
  ErrorNotice,
  Loading,
  Modal,
} from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
import { BoardSettingsDialog } from "../components/board-settings";
import { BoardAddIssuesDialog } from "../components/board-add-issues";
import { IssueDetails } from "./detail";
import { useDesktopIssues } from "../lib/use-desktop-issues";

function isPlainClick(event: MouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function IssuesPage() {
  const { slug } = useParams();
  return <ProjectIssues key={slug} slug={slug || ""} />;
}

function ProjectIssues({ slug }: { slug: string }) {
  const { refresh, users } = useWorkspace();
  const navigate = useNavigate();
  const board = useLocation().pathname.endsWith("/board");
  const desktop = useDesktopIssues();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = useRef(false);
  const opener = useRef<HTMLAnchorElement | null>(null);
  const detailSidebar = useRef<HTMLElement | null>(null);
  const collection = useRef<HTMLDivElement | null>(null);
  const onPendingChange = useCallback((value: boolean) => {
    pending.current = value;
  }, []);
  const canLeaveDetails = useCallback(
    () =>
      !pending.current ||
      window.confirm("Discard unsaved issue changes or comment?"),
    [],
  );
  useEffect(() => {
    if (selectedId) {
      detailSidebar.current?.focus({ preventScroll: true });
    } else if (opener.current) {
      const target = opener.current.isConnected
        ? opener.current
        : collection.current;
      target?.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [selectedId]);
  useEffect(() => {
    if (!desktop && selectedId && canLeaveDetails()) {
      navigate(`/issues/${selectedId}`);
    }
  }, [desktop, selectedId, navigate, canLeaveDetails]);
  function closeDetails() {
    if (!canLeaveDetails()) return;
    setSelectedId(null);
    pending.current = false;
  }
  function openDetails(event: MouseEvent<HTMLAnchorElement>, issue: Issue) {
    if (!desktop || !isPlainClick(event)) return;
    event.preventDefault();
    if (selectedId === issue.id || !canLeaveDetails()) return;
    pending.current = false;
    opener.current = event.currentTarget;
    setSelectedId(issue.id);
  }
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [boardSettings, setBoardSettings] = useState<BoardSettings>({
    lanes: LANES.map((lane) => lane.value),
    cards: [],
  });
  const [configureBoard, setConfigureBoard] = useState(false);
  const [addToBoard, setAddToBoard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [laneFilter, setLaneFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");
  const [body, setBody] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api<{ project: Project }>(
        `/api/projects/${encodeURIComponent(slug || "")}`,
      ),
      api<{ issues: Issue[] }>(
        `/api/projects/${encodeURIComponent(slug || "")}/issues`,
      ),
      api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board`,
      ),
    ])
      .then(([p, i, b]) => {
        if (active) {
          setProject(p.project);
          setIssues(i.issues);
          setBoardSettings(b.board);
        }
      })
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slug, retry]);
  async function move(issue: Issue, next: Lane) {
    if (
      saving ||
      boardSettings.cards.find((card) => card.issueId === issue.id)?.lane ===
        next
    )
      return;
    setSaving(issue.id);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board/issues/${issue.id}`,
        { method: "PATCH", body: JSON.stringify({ lane: next }) },
      );
      setBoardSettings(result.board);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(null);
    }
  }
  async function removeFromBoard(issue: Issue) {
    if (saving) return;
    setSaving(issue.id);
    setError("");
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board/issues/${issue.id}`,
        { method: "DELETE" },
      );
      setBoardSettings(result.board);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(null);
    }
  }
  function boardSaved(settings: BoardSettings) {
    setBoardSettings(settings);
    setLaneFilter("all");
    void refresh().catch((e) => setError(message(e)));
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setCreateError("");
    const data = new FormData(e.currentTarget);
    try {
      validateIssueBody(body);
      const { issue } = await api<{ issue: Issue }>(
        `/api/projects/${encodeURIComponent(slug || "")}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            labels: parseLabels(String(data.get("labels") || "")),
          }),
        },
      );
      await refresh();
      setOpen(false);
      navigate(`/issues/${issue.id}`);
    } catch (e) {
      setCreateError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!project)
    return (
      <>
        <ErrorNotice error={error} />
        <Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>
      </>
    );
  const lanes = LANES.filter((lane) =>
    boardSettings.lanes.includes(lane.value),
  );
  const placements = new Map(
    boardSettings.cards.map((card) => [card.issueId, card.lane]),
  );
  const boardIssues = issues.filter((issue) => placements.has(issue.id));
  const hiddenCount = boardIssues.filter(
    (issue) => !boardSettings.lanes.includes(placements.get(issue.id)!),
  ).length;
  const filtered = (board ? boardIssues : issues).filter(
    (i) =>
      (!board ||
        (boardSettings.lanes.includes(placements.get(i.id)!) &&
          (laneFilter === "all" || placements.get(i.id) === laneFilter))) &&
      `${i.title} ${i.number} ${i.labels.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function issueCard(i: Issue) {
    return (
      <article
        key={i.id}
        className={`${board ? "board-card" : "issue-row"}${selectedId === i.id ? " is-selected" : ""}`}
        draggable={board && !saving}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", i.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {board && <GripVertical size={14} className="drag-hint" />}
        <Link
          className="issue-link"
          to={`/issues/${i.id}`}
          onClick={(event) => openDetails(event, i)}
          aria-current={selectedId === i.id ? "true" : undefined}
          aria-controls={
            desktop && selectedId ? "issue-detail-sidebar" : undefined
          }
        >
          <span className="issue-number">#{i.number}</span>
          <strong>{i.title}</strong>
        </Link>
        <div className="issue-meta">
          {i.labels.slice(0, 3).map((l) => (
            <span className="tag" key={l}>
              {l}
            </span>
          ))}
          <span
            className="avatar small"
            title={
              users.find((u) => u.id === i.assigneeId)?.name || "Unassigned"
            }
          >
            {users.find((u) => u.id === i.assigneeId)?.name.slice(0, 1) || "–"}
          </span>
          {board && (
            <>
              <select
                aria-label={`Lane for issue #${i.number}: ${i.title}`}
                className="compact-select"
                value={placements.get(i.id)}
                disabled={!!saving}
                onChange={(e) => void move(i, e.target.value as Lane)}
              >
                {lanes.map((lane) => (
                  <option key={lane.value} value={lane.value}>
                    {lane.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove issue #${i.number} from board`}
                title="Remove from board (keeps the issue)"
                disabled={!!saving}
                onClick={() => void removeFromBoard(i)}
              >
                <X size={15} />
              </button>
            </>
          )}
        </div>
      </article>
    );
  }
  return (
    <div className={`project-issues${selectedId ? " has-detail" : ""}`}>
      <div className="project-issues-content" ref={collection} tabIndex={-1}>
        <header className="page-heading">
          <div>
            <span className="eyebrow">PROJECT</span>
            <h1>{project.name}</h1>
            <p className="muted">
              {project.description || "Every step forward starts here."}
            </p>
          </div>
          <Button
            onClick={() => {
              setBody("");
              setCreateError("");
              setOpen(true);
            }}
          >
            <Plus size={16} />
            Create issue
          </Button>
        </header>
        <div className="filter-bar">
          <div className="view-toggle">
            <Link className={!board ? "active" : ""} to={`/projects/${slug}`}>
              <List size={16} />
              List
            </Link>
            <Link
              className={board ? "active" : ""}
              to={`/projects/${slug}/board`}
            >
              <Columns3 size={16} />
              Board
            </Link>
          </div>
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Search issues"
              placeholder="Search issues…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {board && (
            <>
              <select
                aria-label="Filter by lane"
                value={laneFilter}
                onChange={(e) => setLaneFilter(e.target.value)}
              >
                <option value="all">All lanes</option>
                {lanes.map((lane) => (
                  <option key={lane.value} value={lane.value}>
                    {lane.label}
                  </option>
                ))}
              </select>
              <Button disabled={!!saving} onClick={() => setAddToBoard(true)}>
                <Plus size={15} /> Add issues
              </Button>
              <Button
                variant="secondary"
                disabled={!!saving}
                onClick={() => setConfigureBoard(true)}
              >
                <SlidersHorizontal size={15} /> Configure board
              </Button>
            </>
          )}
          <span className="muted results-count">{filtered.length} issues</span>
        </div>
        <ErrorNotice error={error} />
        {board ? (
          <>
            <div className="board-summary">
              <p className="muted">
                {`${boardIssues.length} issues on board`}
                {` · ${lanes.length} lanes`}
                {hiddenCount > 0 && ` · ${hiddenCount} issues in hidden lanes`}
              </p>
              {boardIssues.length === 0 && (
                <p>
                  No work on the board yet. Use Add issues to place work in a
                  lane. The list keeps all your issues.
                </p>
              )}
              {boardIssues.length > 0 && filtered.length === 0 && (
                <p>
                  No visible issues. Check your search, lane filter, or selected
                  lanes.
                </p>
              )}
            </div>
            <p className="sr-only">
              Drag issues between lanes, or use each issue’s lane menu.
            </p>
            <div
              className="board"
              style={{ "--board-lanes": lanes.length } as CSSProperties}
            >
              {lanes.map((s) => (
                <section
                  className="board-column"
                  key={s.value}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const i = boardIssues.find(
                      (i) => i.id === e.dataTransfer.getData("text/plain"),
                    );
                    if (i) void move(i, s.value);
                  }}
                >
                  <h2>
                    <span className={`lane-dot ${s.value}`} />
                    {s.label}
                    <span className="count">
                      {
                        filtered.filter((i) => placements.get(i.id) === s.value)
                          .length
                      }
                    </span>
                  </h2>
                  {filtered
                    .filter((i) => placements.get(i.id) === s.value)
                    .map(issueCard)}
                  {!filtered.some((i) => placements.get(i.id) === s.value) && (
                    <p className="column-empty">No issues here yet</p>
                  )}
                </section>
              ))}
            </div>
          </>
        ) : filtered.length ? (
          <div className="issue-list">{filtered.map(issueCard)}</div>
        ) : (
          <section className="empty-state compact">
            <Inbox size={32} />
            <h2>{issues.length ? "No matching issues" : "A clean slate"}</h2>
            <p>
              {issues.length
                ? "Try a different search."
                : "Create your first issue and start making progress."}
            </p>
          </section>
        )}
      </div>
      {selectedId && (
        <aside
          id="issue-detail-sidebar"
          className="issue-detail-sidebar"
          aria-label="Issue details"
          ref={detailSidebar}
          tabIndex={-1}
        >
          <header className="issue-sidebar-header">
            <h2>Issue details</h2>
            <Link
              className="icon-button"
              to={`/issues/${selectedId}`}
              aria-label="Open issue in full page"
              title="Open issue in full page"
              onClick={(event) => {
                if (isPlainClick(event) && !canLeaveDetails())
                  event.preventDefault();
              }}
            >
              <Maximize2 size={17} />
            </Link>
            <button
              className="icon-button"
              aria-label="Close issue details"
              title="Close issue details"
              onClick={closeDetails}
            >
              <X size={18} />
            </button>
          </header>
          <div className="issue-detail-scroll" key={selectedId}>
            <IssueDetails
              id={selectedId}
              embedded
              onPendingChange={onPendingChange}
              onSaved={(updated) =>
                setIssues((current) =>
                  current.map((issue) =>
                    issue.id === updated.id ? updated : issue,
                  ),
                )
              }
            />
          </div>
        </aside>
      )}
      {configureBoard && (
        <BoardSettingsDialog
          slug={slug}
          settings={boardSettings}
          onSaved={boardSaved}
          onClose={() => setConfigureBoard(false)}
        />
      )}
      {addToBoard && (
        <BoardAddIssuesDialog
          slug={slug}
          settings={boardSettings}
          issues={issues}
          onSaved={boardSaved}
          onClose={() => setAddToBoard(false)}
        />
      )}
      <Modal
        className="create-issue-dialog"
        title="Create issue"
        description={`Add an issue to ${project.name}. Place it on the board later when it’s ready for work.`}
        open={open}
        onOpenChange={(v) => !busy && setOpen(v)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <form onSubmit={create} className="form-stack">
          <div>
            <RichEditor
              value={body}
              onChange={setBody}
              ariaLabel="Issue"
              autoFocus
              placeholder="What needs to happen? Just start writing…"
            />
            <p className="settings-help muted">
              Write your issue in one place. A heading or the first line becomes
              its title on the board.
            </p>
          </div>
          <label>
            Labels
            <input name="labels" placeholder="bug, design (comma-separated)" />
          </label>
          <ErrorNotice error={createError} />
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button disabled={busy || !body.trim()}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
