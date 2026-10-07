import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  CircleCheck,
  CircleDot,
  Columns3,
  List,
  Plus,
  Search,
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
import { moveLaneTo, orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
import { CreateIssueDialog } from "../components/create-issue-dialog";
import { IssueTable } from "../components/issue-table";
import { initialIssueTableState, issueTableRows } from "../lib/issue-table";
import { BoardSettingsDialog } from "../components/board-settings";
import { BoardAddIssuesDialog } from "../components/board-add-issues";
import { IssueDetails } from "./detail";
import {
  ArchiveProjectButton,
  ArchivedProjectNotice,
  ClosedTag,
} from "../components/lifecycle";
import { useDesktopIssues } from "../lib/use-desktop-issues";
import { useIssueSidebarWidth } from "../lib/use-issue-sidebar-width";

function isPlainClick(event: MouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// Lane drags carry their own type so columns can tell them apart from card drags.
const LANE_DRAG_TYPE = "application/x-threadline-lane";

interface LaneDrag {
  lane: Lane;
  target: Lane | null;
  /** Set after the drag image is captured, so only the board copy is dimmed. */
  lifted: boolean;
}

export function IssuesPage() {
  const { slug } = useParams();
  return <ProjectIssues key={slug} slug={slug || ""} />;
}

function ProjectIssues({ slug }: { slug: string }) {
  const { refresh, users } = useWorkspace();
  const navigate = useNavigate();
  const board = useLocation().pathname.endsWith("/board");
  const showClosed = useSearchParams()[0].get("state") === "closed";
  const desktop = useDesktopIssues();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = useRef(false);
  const opener = useRef<HTMLAnchorElement | null>(null);
  const detailSidebar = useRef<HTMLElement | null>(null);
  const collection = useRef<HTMLDivElement | null>(null);
  const { width: sidebarWidth, resizing, separatorProps } = useIssueSidebarWidth(
    detailSidebar,
    desktop && !!selectedId,
  );
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
    customLanes: [],
  });
  const [configureBoard, setConfigureBoard] = useState(false);
  const [addToBoard, setAddToBoard] = useState(false);
  const [laneDrag, setLaneDrag] = useState<LaneDrag | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tableState, setTableState] = useState(initialIssueTableState);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
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
    void refresh().catch((e) => setError(message(e)));
  }
  // Dropping a lane on another lane puts it in that lane's position.
  async function reorderLane(lane: Lane, target: Lane) {
    const previous = boardSettings;
    const index = previous.lanes.indexOf(target);
    if (saving || lane === target || index < 0 || !previous.lanes.includes(lane))
      return;
    setSaving(`lane:${lane}`);
    setError("");
    setBoardSettings({ ...previous, lanes: moveLaneTo(previous.lanes, lane, index) });
    try {
      const result = await api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board/lanes/${encodeURIComponent(lane)}`,
        { method: "PATCH", body: JSON.stringify({ index }) },
      );
      setBoardSettings(result.board);
    } catch (e) {
      setBoardSettings(previous);
      setError(message(e));
    } finally {
      setSaving(null);
    }
  }
  function issueCreated(issue: Issue) {
    // Creation is already committed. A workspace refresh failure must not invite
    // a duplicate submission or prevent the next draft from being started.
    setIssues((current) => [...current, issue]);
    void refresh().catch((e) =>
      setError(
        `Issue #${issue.number} was created, but workspace counts could not refresh: ${message(e)}`,
      ),
    );
  }
  if (loading) return <Loading />;
  if (!project)
    return (
      <>
        <ErrorNotice error={error} />
        <Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>
      </>
    );
  // Archived projects are read-only until restored.
  const readOnly = !!project.archivedAt;
  const lanes = orderedLanes(boardSettings.lanes, boardSettings.customLanes);
  const canReorderLanes = lanes.length > 1 && !saving && !readOnly;
  const dragFrom = laneDrag
    ? lanes.findIndex((lane) => lane.value === laneDrag.lane)
    : -1;
  const placements = new Map(
    boardSettings.cards.map((card) => [card.issueId, card.lane]),
  );
  const boardIssues = issues.filter((issue) => placements.has(issue.id));
  const hiddenCount = boardIssues.filter(
    (issue) => !boardSettings.lanes.includes(placements.get(issue.id)!),
  ).length;
  // Closed issues keep their board placement but leave the open list.
  const openIssues = issues.filter((issue) => issue.state === "open");
  const closedIssues = issues.filter((issue) => issue.state === "closed");
  const listIssues = showClosed ? closedIssues : openIssues;
  const searched = (board ? boardIssues : listIssues).filter(
    (i) =>
      (!board || boardSettings.lanes.includes(placements.get(i.id)!)) &&
      `${i.title} ${i.number} ${i.labels.join(" ")} ${users.filter((user) => i.taggedUserIds.includes(user.id)).map((user) => user.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const filtered = board ? searched : issueTableRows(searched, users, tableState);
  function issueCard(i: Issue) {
    const assignee = users.find((user) => user.id === i.assigneeId);
    return (
      <article
        key={i.id}
        className={`board-card${selectedId === i.id ? " is-selected" : ""}${i.state === "closed" ? " is-closed" : ""}`}
        draggable={board && !saving && !readOnly}
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
          {i.state === "closed" && <ClosedTag />}
          {i.labels.slice(0, 3).map((l) => (
            <span className="tag" key={l}>
              {l}
            </span>
          ))}
          {assignee && (
            <span className="avatar small" title={`Assigned to ${assignee.name}`}>
              {assignee.name.slice(0, 1)}
            </span>
          )}
          {board && (
            <>
              <select
                aria-label={`Lane for issue #${i.number}: ${i.title}`}
                className="compact-select"
                value={placements.get(i.id)}
                disabled={!!saving || readOnly}
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
                disabled={!!saving || readOnly}
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
    <div
      className={`project-issues${selectedId ? " has-detail" : ""}${resizing ? " is-resizing" : ""}`}
      style={{ "--issue-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="project-issues-content" ref={collection} tabIndex={-1}>
        <header className="page-heading">
          <div>
            <span className="eyebrow">PROJECT</span>
            <h1>{project.name}</h1>
            <p className="muted">
              {project.description || "Every step forward starts here."}
            </p>
          </div>
          {!readOnly && (
            <div className="page-actions">
              <ArchiveProjectButton project={project} onChange={setProject} />
              <Button onClick={() => setOpen(true)}>
                <Plus size={16} />
                Create issue
              </Button>
            </div>
          )}
        </header>
        {readOnly && (
          <ArchivedProjectNotice project={project} onChange={setProject} />
        )}
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
          {!board && (
            <nav className="view-toggle" aria-label="Issue state">
              <Link
                className={!showClosed ? "active" : ""}
                aria-current={!showClosed ? "page" : undefined}
                to={`/projects/${slug}`}
              >
                <CircleDot size={15} />
                Open <span className="toggle-count">{openIssues.length}</span>
              </Link>
              <Link
                className={showClosed ? "active" : ""}
                aria-current={showClosed ? "page" : undefined}
                to={`/projects/${slug}?state=closed`}
              >
                <CircleCheck size={15} />
                Closed{" "}
                <span className="toggle-count">{closedIssues.length}</span>
              </Link>
            </nav>
          )}
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
              <Button
                disabled={!!saving || readOnly}
                onClick={() => setAddToBoard(true)}
              >
                <Plus size={15} /> Add issues
              </Button>
              <Button
                variant="secondary"
                disabled={!!saving || readOnly}
                onClick={() => setConfigureBoard(true)}
              >
                <SlidersHorizontal size={15} /> Manage lanes
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
                  No visible issues. Check your search or restore a lane using
                  Manage lanes.
                </p>
              )}
            </div>
            <p className="sr-only">
              Drag issues between lanes, or use each issue’s lane menu. Drag a
              lane by its heading to reorder lanes, or use Manage lanes.
            </p>
            <div
              className="board"
              style={{ "--board-lanes": lanes.length } as CSSProperties}
            >
              {lanes.map((s, index) => {
                const drop =
                  laneDrag?.target === s.value && dragFrom >= 0 && dragFrom !== index
                    ? index < dragFrom
                      ? " lane-drop-before"
                      : " lane-drop-after"
                    : "";
                const cards = filtered.filter(
                  (i) => placements.get(i.id) === s.value,
                );
                return (
                  <section
                    className={`board-column${laneDrag?.lifted && laneDrag.lane === s.value ? " is-lane-dragging" : ""}${drop}`}
                    key={s.value}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (laneDrag)
                        setLaneDrag((current) =>
                          current &&
                          (current.target !== s.value || !current.lifted)
                            ? { ...current, target: s.value, lifted: true }
                            : current,
                        );
                    }}
                    onDragLeave={(e) => {
                      if (
                        !laneDrag ||
                        e.currentTarget.contains(e.relatedTarget as Node | null)
                      )
                        return;
                      setLaneDrag((current) =>
                        current?.target === s.value
                          ? { ...current, target: null }
                          : current,
                      );
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (laneDrag) {
                        setLaneDrag(null);
                        void reorderLane(laneDrag.lane, s.value);
                        return;
                      }
                      const i = boardIssues.find(
                        (i) => i.id === e.dataTransfer.getData("text/plain"),
                      );
                      if (i) void move(i, s.value);
                    }}
                  >
                    <h2
                      draggable={canReorderLanes}
                      title={
                        canReorderLanes ? "Drag to reorder lanes" : undefined
                      }
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData(LANE_DRAG_TYPE, s.value);
                        const column = e.currentTarget.parentElement;
                        if (column) {
                          const box = column.getBoundingClientRect();
                          e.dataTransfer.setDragImage(
                            column,
                            e.clientX - box.left,
                            e.clientY - box.top,
                          );
                        }
                        setLaneDrag({ lane: s.value, target: null, lifted: false });
                      }}
                      onDragEnd={() => setLaneDrag(null)}
                    >
                      {lanes.length > 1 && !readOnly && (
                        <GripVertical size={13} className="lane-grip" />
                      )}
                      <span className={`lane-dot ${s.value}`} />
                      <span className="lane-name">{s.label}</span>
                      <span className="count">{cards.length}</span>
                    </h2>
                    {cards.map(issueCard)}
                    {!cards.length && (
                      <p className="column-empty">No issues here yet</p>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          <IssueTable
            issues={filtered}
            allIssues={listIssues}
            users={users}
            state={tableState}
            onChange={setTableState}
            selectedId={selectedId}
            controls={desktop && selectedId ? "issue-detail-sidebar" : undefined}
            onOpen={openDetails}
          />
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
          {desktop && <div className="issue-sidebar-resizer" {...separatorProps} />}
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
      {open && (
        <CreateIssueDialog
          project={project}
          onCreated={issueCreated}
          onClose={() => setOpen(false)}
          canViewIssue={canLeaveDetails}
        />
      )}
    </div>
  );
}
