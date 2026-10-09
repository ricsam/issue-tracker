import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type DragEvent,
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
import { EditProjectDialog } from "../components/edit-project-dialog";
import { IssueTable } from "../components/issue-table";
import { initialIssueTableState, issueTableRows } from "../lib/issue-table";
import { BoardSettingsDialog } from "../components/board-settings";
import { BoardAddIssuesDialog } from "../components/board-add-issues";
import { BoardActionsMenu } from "../components/board-actions-menu";
import { BulkTagDialog } from "../components/bulk-tag-dialog";
import { BulkLabelDialog } from "../components/bulk-label-dialog";
import { IssueDetails } from "./detail";
import {
  ArchiveProjectButton,
  ArchivedProjectNotice,
  ClosedTag,
} from "../components/lifecycle";
import { useDesktopIssues } from "../lib/use-desktop-issues";
import { useIssueSidebarWidth } from "../lib/use-issue-sidebar-width";
import { NEW_ISSUE_KEYS, newIssueTooltip } from "../lib/issue-shortcuts";
import { useGloballyCreatedIssues, useIssueCreationHandler } from "../lib/issue-creation";
import { issueTags } from "../lib/issue-tags";
import { boardDropAnchor, boardOrderTarget, type BoardOrderAction } from "../lib/board-order";
import "./board-order.css";

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
  return <ProjectIssues key={slug ? `project:${slug}` : "all"} slug={slug || ""} />;
}

function ProjectIssues({ slug }: { slug: string }) {
  const { refresh, users, projects } = useWorkspace();
  const all = !slug;
  const listPath = all ? "/issues" : `/projects/${slug}`;
  const navigate = useNavigate();
  const board = useLocation().pathname.endsWith("/board");
  const showClosed = useSearchParams()[0].get("state") === "closed";
  const desktop = useDesktopIssues();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = useRef(false);
  const focusDetails = useRef(true);
  const opener = useRef<HTMLAnchorElement | null>(null);
  const openerId = useRef<string | null>(null);
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
      if (focusDetails.current) detailSidebar.current?.focus({ preventScroll: true });
    } else if (opener.current) {
      const currentLink = openerId.current ? collection.current?.querySelector<HTMLAnchorElement>(`a[data-issue-id="${CSS.escape(openerId.current)}"]`) : null;
      const target = currentLink || (opener.current.isConnected ? opener.current : collection.current);
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
    if (bulkClosing.current || selectedId === issue.id || !canLeaveDetails()) return;
    pending.current = false;
    // Table clicks keep the row focused, so arrows work immediately after opening.
    focusDetails.current = board;
    opener.current = event.currentTarget;
    openerId.current = issue.id;
    setSelectedId(issue.id);
  }
  function navigateIssue(issue: Issue, source: HTMLAnchorElement) {
    if (bulkClosing.current) return false;
    if (selectedId === issue.id) return true;
    if (!canLeaveDetails()) return false;
    pending.current = false;
    focusDetails.current = false;
    opener.current = source;
    openerId.current = issue.id;
    if (desktop) setSelectedId(issue.id);
    else navigate(`/issues/${issue.id}`);
    return true;
  }
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const globallyCreated = useGloballyCreatedIssues();
  const [boardSettings, setBoardSettings] = useState<BoardSettings>({
    lanes: LANES.map((lane) => lane.value),
    cards: [],
    customLanes: [],
  });
  const [configureBoard, setConfigureBoard] = useState(false);
  const [addToBoard, setAddToBoard] = useState(false);
  const [laneDrag, setLaneDrag] = useState<LaneDrag | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tableState, setTableState] = useState(initialIssueTableState);
  const [open, setOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [projectSaved, setProjectSaved] = useState("");
  useIssueCreationHandler(() => setOpen(true), !loading && !loadFailed && (all || !!project));
  useEffect(() => {
    if (loading) return;
    setIssues((current) => {
      const additions = globallyCreated.filter((issue) => (all || issue.projectId === project?.id) && !current.some((item) => item.id === issue.id));
      return additions.length ? [...current, ...additions] : current;
    });
  }, [globallyCreated, loading, all, project?.id]);
  const existingTags = issueTags(issues);
  const [saving, setSaving] = useState<string | null>(null);
  const boardBusy = useRef(false);
  const [boardSelection, setBoardSelection] = useState<string[]>([]);
  const boardAnchor = useRef<string | null>(null);
  const cardDrag = useRef<string[]>([]);
  const [cardDrop, setCardDrop] = useState<{ lane: Lane; targetId: string | null; after: boolean } | null>(null);
  const [boardOutcome, setBoardOutcome] = useState("");
  const [tagging, setTagging] = useState<{ ids: string[]; kind: "mentions" | "labels" } | null>(null);
  useEffect(() => {
    setBoardSelection([]);
    boardAnchor.current = null;
  }, [board, query, project?.archivedAt]);
  useEffect(() => {
    const visible = new Set(boardSettings.cards.filter((card) => boardSettings.lanes.includes(card.lane)).map((card) => card.issueId));
    setBoardSelection((current) => current.filter((id) => visible.has(id)));
    if (boardAnchor.current && !visible.has(boardAnchor.current)) boardAnchor.current = null;
  }, [boardSettings]);
  function tagIssues(ids: string[], kind: "mentions" | "labels" = "mentions") {
    if (project?.archivedAt || bulkClosing.current || boardBusy.current || !ids.length) return;
    if (selectedId && ids.includes(selectedId)) {
      if (!canLeaveDetails()) return;
      setSelectedId(null);
      pending.current = false;
    }
    setTagging({ ids: [...ids], kind });
  }
  function tagsSaved(updated: Issue[]) {
    const changes = new Map(updated.map((issue) => [issue.id, issue]));
    setIssues((current) => current.map((issue) => changes.get(issue.id) ?? issue));
  }
  const [retry, setRetry] = useState(0);
  const bulkClosing = useRef(false);
  const [closingIssues, setClosingIssues] = useState(false);
  async function closeIssues(ids: string[]): Promise<{ closedIds: string[]; error?: string }> {
    if (bulkClosing.current || project?.archivedAt) return { closedIds: [] };
    const targets = issues.filter((issue) => ids.includes(issue.id) && issue.state === "open");
    if (!targets.length) return { closedIds: [] };
    // Do not silently discard an editor draft when its issue is part of the batch.
    if (selectedId && targets.some((issue) => issue.id === selectedId)) {
      if (!canLeaveDetails()) return { closedIds: [] };
      setSelectedId(null);
      pending.current = false;
    }
    bulkClosing.current = true;
    setClosingIssues(true);
    const closedIds: string[] = [];
    const failures: string[] = [];
    try {
      // Bound concurrency; each result is committed independently so failed
      // items can be retried without submitting successful closes again.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (next < targets.length) {
          const issue = targets[next++]!;
          try {
            const { issue: updated } = await api<{ issue: Issue }>(`/api/issues/${issue.id}`, {
              method: "PATCH",
              body: JSON.stringify({ state: "closed" }),
            });
            closedIds.push(updated.id);
            setIssues((current) => current.map((item) => item.id === updated.id ? updated : item));
          } catch (cause) {
            failures.push(`#${issue.number}: ${message(cause)}`);
          }
        }
      }));
      if (closedIds.length) {
        try { await refresh(); }
        catch (cause) { setError(`Issues closed, but workspace counts could not refresh: ${message(cause)}`); }
      }
      return {
        closedIds,
        error: failures.length ? `Could not close ${failures.length} issue${failures.length === 1 ? "" : "s"}. ${failures.join("; ")}` : undefined,
      };
    } finally {
      bulkClosing.current = false;
      setClosingIssues(false);
    }
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    Promise.all([
      all ? Promise.resolve({ project: null }) : api<{ project: Project }>(
        `/api/projects/${encodeURIComponent(slug)}`,
      ),
      api<{ issues: Issue[] }>(all ? "/api/issues" :
        `/api/projects/${encodeURIComponent(slug)}/issues`,
      ),
      all ? Promise.resolve({ board: { lanes: [], cards: [], customLanes: [] } }) : api<{ board: BoardSettings }>(
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
      .catch((e) => { if (active) { setLoadFailed(true); setError(message(e)); } })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slug, retry]);
  async function changeBoard(ids: string[], next?: Lane) {
    if (saving || boardBusy.current || project?.archivedAt || (next && !boardSettings.lanes.includes(next))) return;
    const placed = new Map(boardSettings.cards.map((card) => [card.issueId, card.lane]));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const targets = ids.flatMap((id) => placed.has(id) && byId.has(id) ? [byId.get(id)!] : []);
    if (!targets.length) return;
    boardBusy.current = true;
    setSaving("cards");
    setError("");
    setBoardOutcome("");
    const succeeded: string[] = [];
    const failures: string[] = [];
    try {
      // Responses contain the whole board: commit serially, never replace a
      // newer board with an older parallel response. Failed cards stay selected.
      for (const issue of targets) {
        try {
          if (next !== placed.get(issue.id)) {
            const result = await api<{ board: BoardSettings }>(
              `/api/projects/${encodeURIComponent(slug)}/board/issues/${issue.id}`,
              next ? { method: "PATCH", body: JSON.stringify({ lane: next }) } : { method: "DELETE" },
            );
            setBoardSettings(result.board);
          }
          succeeded.push(issue.id);
        } catch (cause) {
          failures.push(`#${issue.number}: ${message(cause)}`);
        }
      }
      setBoardSelection((current) => current.filter((id) => !succeeded.includes(id)));
      setBoardOutcome(`${succeeded.length} of ${targets.length} issues ${next ? "moved" : "removed from board"}.`);
      if (failures.length) setError(`Could not ${next ? "move" : "remove"} ${failures.length} issue${failures.length === 1 ? "" : "s"}. ${failures.join("; ")}`);
      if (succeeded.length) {
        try { await refresh(); }
        catch (cause) { setError(`Board updated, but workspace counts could not refresh: ${message(cause)}`); }
      }
    } finally {
      boardBusy.current = false;
      setSaving(null);
    }
  }
  async function reorderCards(ids: string[], lane: Lane, beforeIssueId: string | null) {
    if (saving || boardBusy.current || project?.archivedAt || !ids.length || !boardSettings.lanes.includes(lane)) return;
    boardBusy.current = true;
    setSaving("cards");
    setError("");
    setBoardOutcome("");
    try {
      const result = await api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(slug)}/board/issues/reorder`, {
        method: "POST", body: JSON.stringify({ issueIds: ids, lane, beforeIssueId }),
      });
      setBoardSettings(result.board);
      setBoardSelection((current) => current.filter((id) => !ids.includes(id)));
      boardAnchor.current = null;
      setBoardOutcome(`${ids.length} issue${ids.length === 1 ? "" : "s"} reordered.`);
      try { await refresh(); }
      catch (cause) { setError(`Board reordered, but workspace counts could not refresh: ${message(cause)}`); }
    } catch (cause) {
      // Keep the saved order and selection on failure; never manufacture a successful drop.
      setError(`Could not reorder issues: ${message(cause)}`);
    } finally {
      boardBusy.current = false;
      setSaving(null);
    }
  }
  function reorderActions(ids: string[]) {
    const destinations = {
      up: boardOrderTarget(boardSettings.cards, ids, "up"),
      down: boardOrderTarget(boardSettings.cards, ids, "down"),
      top: boardOrderTarget(boardSettings.cards, ids, "top"),
      bottom: boardOrderTarget(boardSettings.cards, ids, "bottom"),
    };
    return {
      reorderAvailable: { up: !!destinations.up, down: !!destinations.down, top: !!destinations.top, bottom: !!destinations.bottom },
      onReorder: (action: BoardOrderAction) => {
        const target = destinations[action];
        if (target) void reorderCards(boardSettings.cards.filter((card) => ids.includes(card.issueId)).map((card) => card.issueId), target.lane, target.beforeIssueId);
      },
    };
  }
  function boardSaved(settings: BoardSettings) {
    setBoardSettings(settings);
    void refresh().catch((e) => setError(message(e)));
  }
  // Dropping a lane on another lane puts it in that lane's position.
  async function reorderLane(lane: Lane, target: Lane) {
    const previous = boardSettings;
    const index = previous.lanes.indexOf(target);
    if (saving || boardBusy.current || project?.archivedAt || lane === target || index < 0 || !previous.lanes.includes(lane))
      return;
    boardBusy.current = true;
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
      boardBusy.current = false;
      setSaving(null);
    }
  }
  function issueCreated(issue: Issue) {
    // Creation is already committed. A workspace refresh failure must not invite
    // a duplicate submission or prevent the next draft from being started.
    if (all || issue.projectId === project?.id) setIssues((current) => [...current, issue]);
    void refresh().catch((e) =>
      setError(
        `Issue #${issue.number} was created, but workspace counts could not refresh: ${message(e)}`,
      ),
    );
  }
  if (loading) return <Loading />;
  if (loadFailed || (!all && !project))
    return (
      <>
        <ErrorNotice error={error} />
        <Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>
      </>
    );
  // Archived projects are read-only until restored.
  const readOnly = !!project?.archivedAt;
  const lanes = orderedLanes(boardSettings.lanes, boardSettings.customLanes);
  const canReorderLanes = lanes.length > 1 && !saving && !readOnly;
  const dragFrom = laneDrag
    ? lanes.findIndex((lane) => lane.value === laneDrag.lane)
    : -1;
  const placements = new Map(
    boardSettings.cards.map((card) => [card.issueId, card.lane]),
  );
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const boardIssues = boardSettings.cards.flatMap((card) => issueById.get(card.issueId) ?? []);
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
  const filtered = board ? searched : issueTableRows(searched, users, tableState, projects);
  const boardOrder = lanes.flatMap((lane) => filtered.filter((issue) => placements.get(issue.id) === lane.value).map((issue) => issue.id));
  const selectedBoard = boardSelection.filter((id) => boardOrder.includes(id));
  function selectBoardIssue(id: string, checked: boolean, range = false) {
    if (saving || readOnly) return;
    const anchor = boardAnchor.current ? boardOrder.indexOf(boardAnchor.current) : -1;
    const index = boardOrder.indexOf(id);
    const targets = range && anchor >= 0 ? boardOrder.slice(Math.min(anchor, index), Math.max(anchor, index) + 1) : [id];
    setBoardSelection((current) => checked ? [...new Set([...current, ...targets])] : current.filter((item) => !targets.includes(item)));
    if (!range || anchor < 0) boardAnchor.current = id;
  }
  function issueCard(i: Issue) {
    const checked = selectedBoard.includes(i.id);
    const targets = checked ? selectedBoard : [i.id];
    const currentLane = targets.every((id) => placements.get(id) === placements.get(i.id)) ? placements.get(i.id) : undefined;
    const dropClass = cardDrop?.targetId === i.id ? cardDrop.after ? " card-drop-after" : " card-drop-before" : "";
    const dropOnCard = (event: DragEvent<HTMLElement>, commit: boolean) => {
      if (laneDrag || !cardDrag.current.length || saving || readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      if (cardDrag.current.includes(i.id)) { setCardDrop(null); return; }
      const box = event.currentTarget.getBoundingClientRect();
      const after = event.clientY >= box.top + box.height / 2;
      const lane = placements.get(i.id)!;
      if (!commit) {
        event.dataTransfer.dropEffect = "move";
        setCardDrop({ lane, targetId: i.id, after });
        return;
      }
      const ids = [...cardDrag.current];
      const before = boardDropAnchor(boardSettings.cards, ids, lane, i.id, after);
      cardDrag.current = [];
      setCardDrop(null);
      if (before !== undefined) void reorderCards(ids, lane, before);
    };
    return (
      <article
        key={i.id}
        className={`board-card${selectedId === i.id ? " is-selected" : ""}${checked ? " is-bulk-selected" : ""}${i.state === "closed" ? " is-closed" : ""}${dropClass}`}
        onDragOver={(event) => dropOnCard(event, false)}
        onDrop={(event) => dropOnCard(event, true)}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCardDrop((current) => current?.targetId === i.id ? null : current); }}
        onClickCapture={(event) => {
          if (event.button !== 0 || event.altKey || !(event.metaKey || event.ctrlKey || event.shiftKey)) return;
          // Checkboxes keep their native toggle; popover items are not card surfaces.
          if ((event.target as HTMLElement).closest("input, [popover]")) return;
          event.preventDefault();
          event.stopPropagation();
          selectBoardIssue(i.id, event.shiftKey || !checked, event.shiftKey);
        }}
        onDragStart={(event) => {
          // Links and selected text must never initiate a card move.
          if (!(event.target as Element).closest(".board-card-handle")) event.preventDefault();
        }}
      >
        <div className="board-card-toolbar">
          <input type="checkbox" aria-label={`Select issue #${i.number}`} checked={checked} disabled={!!saving || readOnly}
            onClick={(event) => {
              if (event.shiftKey) selectBoardIssue(i.id, !checked, true);
            }}
            onChange={(event) => {
              if (!(event.nativeEvent as globalThis.MouseEvent).shiftKey) selectBoardIssue(i.id, event.target.checked);
            }} />
          <span
            className="board-card-handle"
            aria-label={`Drag issue #${i.number}`}
            title="Drag to reorder or move issue; use Board actions for keyboard controls"
            draggable={!saving && !readOnly}
            onDragStart={(event) => {
              if (saving || readOnly) { event.preventDefault(); return; }
              cardDrag.current = [...targets];
              setCardDrop(null);
              event.dataTransfer.setData("text/plain", i.id);
              event.dataTransfer.effectAllowed = "move";
              const card = event.currentTarget.closest<HTMLElement>(".board-card");
              if (card) {
                const box = card.getBoundingClientRect();
                event.dataTransfer.setDragImage(card, event.clientX - box.left, event.clientY - box.top);
              }
            }}
            onDragEnd={() => { cardDrag.current = []; setCardDrop(null); }}
          ><GripVertical size={14} className="drag-hint" /></span>
          <BoardActionsMenu label={`Board actions for issue #${i.number}`} lanes={lanes} currentLane={currentLane}
            count={targets.length} disabled={!!saving || readOnly} {...reorderActions(targets)}
            onMove={(lane) => void changeBoard(targets, lane)} onRemove={() => void changeBoard(targets)} />
        </div>
        <Link
          className="issue-link"
          aria-label={i.title}
          draggable={false}
          data-issue-id={i.id}
          to={`/issues/${i.id}`}
          onClick={(event) => openDetails(event, i)}
          aria-current={selectedId === i.id ? "true" : undefined}
          aria-controls={
            desktop && selectedId ? "issue-detail-sidebar" : undefined
          }
        >
          <span className="issue-number">#{i.number}</span>
          <strong>{i.title}</strong>
        <div className="issue-meta">
          {i.state === "closed" && <ClosedTag />}
          {i.labels.slice(0, 3).map((l) => (
            <span className="tag" key={l}>
              {l}
            </span>
          ))}

        </div>
        </Link>
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
            <span className="eyebrow">{all ? "WORKSPACE" : "PROJECT"}</span>
            <h1>{all ? "All issues" : project!.name}</h1>
            <p className="muted">
              {all ? "Every issue across your workspace, with or without a project." : project!.description || "Every step forward starts here."}
            </p>
          </div>
          {!readOnly && (
            <div className="page-actions">
              {project && <>
                <Button variant="secondary" onClick={() => { setProjectSaved(""); setEditingProject(true); }}>Edit project</Button>
                <ArchiveProjectButton project={project} onChange={setProject} />
              </>}
              <Button onClick={() => setOpen(true)} title={newIssueTooltip()} aria-keyshortcuts={NEW_ISSUE_KEYS}>
                <Plus size={16} />
                Create issue
              </Button>
            </div>
          )}
        </header>
        {projectSaved && <p className="success" role="status">{projectSaved}</p>}
        {readOnly && project && (
          <ArchivedProjectNotice project={project} onChange={setProject} />
        )}
        <div className="filter-bar">
          {!all && <div className="view-toggle">
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
          </div>}
          {!board && (
            <nav className="view-toggle" aria-label="Issue state">
              <Link
                className={!showClosed ? "active" : ""}
                aria-current={!showClosed ? "page" : undefined}
                to={listPath}
              >
                <CircleDot size={15} />
                Open <span className="toggle-count">{openIssues.length}</span>
              </Link>
              <Link
                className={showClosed ? "active" : ""}
                aria-current={showClosed ? "page" : undefined}
                to={`${listPath}?state=closed`}
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
            <div className="issue-bulk-actions issue-board-actions" role="group" aria-label="Selected board issue actions" aria-busy={!!saving}>
              <p className="board-summary muted">
                {`${boardIssues.length} issues on board`}
                {` · ${lanes.length} lanes`}
                {hiddenCount > 0 && ` · ${hiddenCount} issues in hidden lanes`}
              </p>
              <Button variant="ghost" disabled={!!saving || readOnly || !boardOrder.length} onClick={() => setBoardSelection(boardOrder)}>Select visible issues</Button>
              <span className="issue-selection-count">{selectedBoard.length} selected</span>
              <BoardActionsMenu label="Selected board issue actions" text="Board actions" count={selectedBoard.length} lanes={lanes}
                currentLane={selectedBoard.length && selectedBoard.every((id) => placements.get(id) === placements.get(selectedBoard[0])) ? placements.get(selectedBoard[0]) : undefined}
                {...reorderActions(selectedBoard)}
                disabled={!!saving || readOnly || !selectedBoard.length} onMove={(lane) => void changeBoard(selectedBoard, lane)} onRemove={() => void changeBoard(selectedBoard)} />
              <Button variant="secondary" disabled={!!saving || readOnly || !selectedBoard.length} onClick={() => tagIssues(selectedBoard)}>Tag selected issues</Button>
              <Button variant="secondary" disabled={!!saving || readOnly || !selectedBoard.length} onClick={() => tagIssues(selectedBoard, "labels")}>Add tags</Button>
              <Button variant="ghost" disabled={!!saving || !selectedBoard.length} onClick={() => { setBoardSelection([]); boardAnchor.current = null; }}>Clear selection</Button>
            </div>
            {boardIssues.length === 0 && (
              <p className="board-empty-notice">
                No work on the board yet. Use Add issues to place work in a
                lane. The list keeps all your issues.
              </p>
            )}
            {boardIssues.length > 0 && filtered.length === 0 && (
              <p className="board-empty-notice">
                No visible issues. Check your search or restore a lane using
                Manage lanes.
              </p>
            )}
            <p className="board-outcome" role="status">{boardOutcome}</p>
            <p className="sr-only">
              Drag issues by their handle before or after another issue, or to the end of a lane. Use each issue’s board actions menu to move up, down, to the top or bottom. Drag a selected issue’s handle to move the selection.
              Drag a lane by its heading to reorder lanes, or use Manage lanes.
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
                    className={`board-column${laneDrag?.lifted && laneDrag.lane === s.value ? " is-lane-dragging" : ""}${drop}${cardDrop?.lane === s.value && cardDrop.targetId === null ? " card-drop-end" : ""}`}
                    key={s.value}
                    onDragOver={(e) => {
                      if (saving || readOnly || (!laneDrag && !cardDrag.current.length)) return;
                      e.preventDefault();
                      if (!laneDrag) setCardDrop({ lane: s.value, targetId: null, after: true });
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
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCardDrop((current) => current?.lane === s.value ? null : current);
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
                      const ids = [...cardDrag.current];
                      cardDrag.current = [];
                      setCardDrop(null);
                      if (ids.length) void reorderCards(ids, s.value, null);
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
            projects={all ? projects : undefined}
            state={tableState}
            onChange={setTableState}
            paginationKey={JSON.stringify([query, showClosed])}
            readOnly={readOnly}
            onCloseIssues={closeIssues}
            selectedId={selectedId}
            controls={desktop && selectedId ? "issue-detail-sidebar" : undefined}
            onOpen={openDetails}
            onNavigate={navigateIssue}
            onTagIssues={tagIssues}
            onLabelIssues={(ids) => tagIssues(ids, "labels")}
            onBoardChanged={(projectId, settings) => { if (projectId === project?.id) setBoardSettings(settings); }}
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
          <div className="issue-detail-scroll" inert={closingIssues}>
            <IssueDetails
              id={selectedId}
              existingTags={existingTags}
              embedded
              onBoardChanged={(projectId, settings) => { if (projectId === project?.id) setBoardSettings(settings); }}
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
      {editingProject && project && <EditProjectDialog project={project}
        onSaved={(updated) => { setProject(updated); setProjectSaved("Project updated"); }}
        onClose={() => setEditingProject(false)} />}
      {tagging?.kind === "mentions" && <BulkTagDialog slug={slug || undefined} issueIds={tagging.ids} users={users}
        onSaved={tagsSaved} onClose={() => setTagging(null)} />}
      {tagging?.kind === "labels" && <BulkLabelDialog slug={slug || undefined} issueIds={tagging.ids}
        existingLabels={existingTags}
        onSaved={tagsSaved} onClose={() => setTagging(null)} />}
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
          project={readOnly ? null : project}
          existingTags={readOnly ? undefined : existingTags}
          onCreated={issueCreated}
          onClose={() => setOpen(false)}
          canViewIssue={canLeaveDetails}
          onViewIssue={desktop ? (issue, source) => {
            if (!all && issue.projectId !== project?.id) {
              setOpen(false);
              navigate(`/issues/${issue.id}`);
              return;
            }
            pending.current = false;
            focusDetails.current = true;
            opener.current = source;
            openerId.current = issue.id;
            setOpen(false);
            setSelectedId(issue.id);
          } : undefined}
        />
      )}
    </div>
  );
}
