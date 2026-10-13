import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { orderedLanes } from "../../shared/board";
import { LANES, type BoardSettings, type Issue } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice } from "./ui/primitives";
import "./issue-placement-controls.css";

type Props = {
  issue: Issue;
  /** The current project's fresh board, when the parent already has it. */
  board?: BoardSettings;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onMoved: (issue: Issue) => void;
  onBoardChanged: (projectId: string, board: BoardSettings) => void;
};
type BoardState = { projectId: string; board?: BoardSettings; loading: boolean; error: string };

/** Placement writes deliberately never submit body/comment drafts. */
export function IssuePlacementControls({ issue, board: knownBoard, disabled = false, onBusyChange, onMoved, onBoardChanged }: Props) {
  const { projects, refresh } = useWorkspace();
  const project = projects.find((item) => item.id === issue.projectId);
  const [projectOpen, setProjectOpen] = useState(false);
  const [laneOpen, setLaneOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<BoardState | null>(null);
  const submitting = useRef(false);
  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const forceReload = useRef(false);
  const mounted = useRef(true);
  const currentIssue = useRef(issue);
  currentIssue.current = issue;
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const board = loaded?.projectId === issue.projectId ? loaded.board : knownBoard;
  const loading = !!project && (loaded?.projectId !== project.id ? !knownBoard : loaded.loading);
  const loadError = loaded?.projectId === issue.projectId ? loaded.error : "";
  const card = board?.cards.find((item) => item.issueId === issue.id);
  const lanes = board ? orderedLanes(board.lanes, board.customLanes, board.laneLabels) : [];
  const laneLabel = card ? board?.laneLabels?.[card.lane] || [...LANES, ...(board?.customLanes || [])].find((lane) => lane.value === card.lane)?.label || card.lane : "No board lane";
  const readOnly = !!project?.archivedAt || (!!issue.projectId && !project);
  const locked = disabled || busy || readOnly;
  const closedOffBoard = issue.state === "closed" && !!board && !card;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      if (submitting.current) busyCallback.current?.(false);
    };
  }, []);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    if (!project) { setLoaded(null); return; }
    const reload = forceReload.current;
    forceReload.current = false;
    if (knownBoard && !reload) {
      setLoaded({ projectId: project.id, board: knownBoard, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    loadController.current = controller;
    const projectId = project.id;
    setLoaded({ projectId, loading: true, error: "" });
    api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(project.slug)}/board`, { signal: controller.signal })
      .then(({ board }) => {
        if (!controller.signal.aborted && generation === loadGeneration.current)
          setLoaded({ projectId, board, loading: false, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === loadGeneration.current)
          setLoaded({ projectId, loading: false, error: `Could not load board lanes: ${message(cause)}` });
      });
    return () => controller.abort();
  }, [project?.id, project?.slug, knownBoard, retry]);

  useEffect(() => {
    setProjectOpen(false);
    setLaneOpen(false);
    setError("");
    setWarning("");
  }, [issue.id, issue.projectId]);

  async function change(kind: "project" | "lane", value: string) {
    if (submitting.current || locked) return;
    if (kind === "project" && (value === (issue.projectId || "") || (value && !projects.some((item) => item.id === value && !item.archivedAt)))) return;
    if (kind === "lane" && (!project || !board || loading || closedOffBoard || value === (card?.lane || "") || (value && !board.lanes.includes(value)))) return;
    submitting.current = true;
    setBusy(true);
    busyCallback.current?.(true);
    setError("");
    setWarning("");
    // A GET started before this write must not put the old lane back afterwards.
    ++loadGeneration.current;
    loadController.current?.abort();
    let saved = false;
    const source = { id: issue.id, projectId: issue.projectId };
    const stillCurrent = () => mounted.current && currentIssue.current.id === source.id && currentIssue.current.projectId === source.projectId;
    try {
      if (kind === "project") {
        let result: { issue: Issue };
        try {
          result = await api<{ issue: Issue }>(`/api/issues/${issue.id}`, {
            method: "PATCH", body: JSON.stringify({ projectId: value || null }),
          });
        } catch (cause) {
          if (stillCurrent()) setError(`Could not change project: ${message(cause)}. Select the project again to retry.`);
          return;
        }
        saved = true;
        if (stillCurrent()) {
          setProjectOpen(false);
          onMoved(result.issue);
        }
      } else {
        let result: { board: BoardSettings };
        const path = `/api/projects/${encodeURIComponent(project!.slug)}/board/issues`;
        try {
          result = await api<{ board: BoardSettings }>(value ? path : `${path}/${issue.id}`, value ? {
            method: "PUT", body: JSON.stringify({ issueIds: [issue.id], lane: value }),
          } : { method: "DELETE" });
        } catch (cause) {
          if (stillCurrent()) setError(`Could not change board lane: ${message(cause)}. Select the lane again to retry.`);
          return;
        }
        saved = true;
        if (stillCurrent()) {
          setLoaded({ projectId: project!.id, board: result.board, loading: false, error: "" });
          setLaneOpen(false);
          onBoardChanged(project!.id, result.board);
        }
      }
      // A successful mutation is not retryable just because counts failed to load.
      try { await refresh(); }
      catch (cause) {
        if (mounted.current && currentIssue.current.id === source.id)
          setWarning(`Placement saved, but workspace counts could not refresh: ${message(cause)}`);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        busyCallback.current?.(false);
        // A failed project write may have cancelled the initial board GET.
        if (!saved && loading && stillCurrent()) setRetry((value) => value + 1);
      }
    }
  }

  return <div className="issue-placement-controls" aria-busy={busy}>
    <div className="issue-placement-pickers">
      <Popover.Root open={projectOpen} onOpenChange={(open) => !submitting.current && setProjectOpen(open)}>
        <Popover.Trigger asChild>
          <button type="button" className="issue-placement-trigger" aria-label="Change project" disabled={locked} title={readOnly ? "This project is read-only" : project?.name || "No project"}>
            <span>{project?.name || (issue.projectId ? "Project unavailable" : "No project")}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal><Popover.Content className="issue-placement-popover" align="start" sideOffset={6} collisionPadding={12} aria-label="Choose project">
          <label>Project<select value={issue.projectId || ""} disabled={locked} onChange={(event) => void change("project", event.target.value)}>
            <option value="">No project</option>
            {projects.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <p>Choosing a project immediately removes placement on the previous project’s board. It does not add the issue to the new board. Unsaved drafts are preserved.</p>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
      <Popover.Root open={laneOpen} onOpenChange={(open) => !submitting.current && setLaneOpen(open)}>
        <Popover.Trigger asChild>
          <button type="button" className="issue-placement-trigger" aria-label="Change board lane" disabled={locked || !project} title={!project ? "Choose a project first" : readOnly ? "This project is read-only" : laneLabel}>
            <span>{loading ? "Loading board lane…" : loadError ? "Board lane unavailable" : laneLabel}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal><Popover.Content className="issue-placement-popover" align="start" sideOffset={6} collisionPadding={12} aria-label="Choose board lane">
          {loading && <p role="status">Loading board lanes…</p>}
          <ErrorNotice error={loadError} />
          {board && <>
            <label>Board lane<select value={card?.lane || ""} disabled={locked || loading || closedOffBoard || (!lanes.length && !card)} onChange={(event) => void change("lane", event.target.value)}>
              <option value="">No board lane</option>
              {card && !lanes.some((lane) => lane.value === card.lane) && <option value={card.lane} disabled>{laneLabel} (hidden)</option>}
              {lanes.map((lane) => <option key={lane.value} value={lane.value}>{lane.label}</option>)}
            </select></label>
            {closedOffBoard ? <p>Reopen this closed issue before adding it to the board.</p> : <p>Changes board placement immediately without changing issue state or unsaved drafts.</p>}
            {!lanes.length && <p>No visible lanes. Show a lane on this project’s board first.</p>}
          </>}
          {(loadError || error || (board && !lanes.length)) && <Button type="button" variant="secondary" disabled={locked || loading} onClick={() => { forceReload.current = true; setRetry((value) => value + 1); }}>Retry loading board lanes</Button>}
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </div>
    <ErrorNotice error={error} />
    {warning && <p className="issue-placement-warning" role="status">{warning}</p>}
  </div>;
}
