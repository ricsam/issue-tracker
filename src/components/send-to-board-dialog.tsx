import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BoardSettings, Issue, Project } from "../../shared/types";
import { orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import { Notification } from "./ui/snackbar";
import "./send-to-board-dialog.css";

type ProjectGroup = {
  project: Project;
  issues: Issue[];
  board?: BoardSettings;
  lane: string;
  loading: boolean;
  error: string;
  sent: boolean;
};

/** The selection is captured on open. Each project is atomic; retries exclude successes. */
export function SendToBoardDialog({ issues, onPlaced, onClose }: {
  issues: Issue[];
  onPlaced: (projectId: string, board: BoardSettings, issueIds: string[]) => void;
  onClose: () => void;
}) {
  const { projects, refresh } = useWorkspace();
  const [groups, setGroups] = useState<ProjectGroup[]>(() => projects.filter((project) =>
    !project.archivedAt && issues.some((issue) => issue.projectId === project.id),
  ).map((project) => ({ project, issues: issues.filter((issue) => issue.projectId === project.id), lane: "", loading: true, error: "", sent: false })));
  const [skipped] = useState(() => issues.filter((issue) => !projects.some((project) => project.id === issue.projectId && !project.archivedAt)));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const patch = (projectId: string, change: Partial<ProjectGroup>) => setGroups((current) => current.map((group) => group.project.id === projectId ? { ...group, ...change } : group));
  const targets = (group: ProjectGroup) => group.issues.filter((issue) => issue.state === "open" || group.board?.cards.some((card) => card.issueId === issue.id));

  async function load(group: ProjectGroup, signal: AbortSignal) {
    patch(group.project.id, { loading: true, error: "" });
    try {
      const { board } = await api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(group.project.slug)}/board`, { signal });
      if (signal.aborted) return;
      const placed = board.cards.filter((card) => group.issues.some((issue) => issue.id === card.issueId));
      const sharedLane = placed.length === group.issues.length && placed.every((card) => card.lane === placed[0]?.lane) ? placed[0]?.lane : undefined;
      patch(group.project.id, { board, loading: false, lane: board.lanes.includes(group.lane) ? group.lane : sharedLane && board.lanes.includes(sharedLane) ? sharedLane : board.lanes[0] || "" });
    } catch (cause) {
      if (!signal.aborted) patch(group.project.id, { loading: false, error: `Could not load board: ${message(cause)}` });
    }
  }
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let next = 0;
    void Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
      while (next < groups.length && !active.signal.aborted) await load(groups[next++]!, active.signal);
    }));
    return () => active.abort();
  }, []);

  const pending = groups.filter((group) => !group.sent && group.board && !group.loading && targets(group).length > 0);
  const ready = pending.filter((group) => group.board!.lanes.includes(group.lane) && targets(group).length <= 1000);
  const count = ready.reduce((sum, group) => sum + targets(group).length, 0);
  const hasSuccess = groups.some((group) => group.sent);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !ready.length || groups.some((group) => group.loading)) return;
    submitting.current = true;
    setBusy(true);
    setNotice("");
    setWarning("");
    let sent = 0;
    let failed = 0;
    try {
      for (const group of ready) {
        const issueIds = targets(group).map((issue) => issue.id);
        patch(group.project.id, { error: "" });
        let board: BoardSettings;
        try {
          const result = await api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(group.project.slug)}/board/issues`, {
            method: "PUT", body: JSON.stringify({ issueIds, lane: group.lane }),
          });
          board = result.board;
        } catch (cause) {
          failed += issueIds.length;
          patch(group.project.id, { error: message(cause) });
          continue;
        }
        // The write has succeeded; never turn a counts-refresh failure into a retry.
        sent += issueIds.length;
        patch(group.project.id, { board, sent: true });
        onPlaced(group.project.id, board, issueIds);
      }
      setNotice(`${sent} issue${sent === 1 ? "" : "s"} sent to board.${failed ? ` ${failed} could not be sent; retry the remaining projects.` : ""}`);
      if (sent) {
        try { await refresh(); }
        catch (cause) { setWarning(`Board updated, but workspace counts could not refresh: ${message(cause)}`); }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <Modal title="Send to board" description="Choose a destination lane on each issue’s project board. Issues already on a board will move to that lane."
    open onOpenChange={(open) => !open && !submitting.current && onClose()} className="send-to-board-dialog">
    <form className="form-stack" onSubmit={send} aria-busy={busy}>
      <p className="muted">This only changes board placement. Issue content, state, and unsaved drafts are left unchanged.</p>
      {skipped.length > 0 && <p className="board-placement-note" role="status">{skipped.length} issue{skipped.length === 1 ? "" : "s"} will not be sent: issues without a project have no board, and archived projects are read-only.</p>}
      {groups.map((group) => {
        const eligible = targets(group);
        const closed = group.issues.length - eligible.length;
        const lanes = group.board ? orderedLanes(group.board.lanes, group.board.customLanes) : [];
        const placed = group.board?.cards.filter((card) => eligible.some((issue) => issue.id === card.issueId)).length || 0;
        return <section key={group.project.id} className="board-placement-group" aria-label={`${group.project.name} board`}>
          <h3>{group.project.name}</h3>
          {group.loading ? <p role="status" className="muted">Loading board lanes…</p> : <>
            {group.board && <>
              <p className="muted">{eligible.length} selected · {eligible.length - placed} not on board · {placed} already on board</p>
              {closed > 0 && <p className="board-placement-note">{closed} closed issue{closed === 1 ? " is" : "s are"} not on this board. Reopen {closed === 1 ? "it" : "them"} before adding.</p>}
              {group.sent ? <p className="success">Sent to {lanes.find((lane) => lane.value === group.lane)?.label || group.lane}.</p> : eligible.length > 0 && <label>Lane for {group.project.name}
                <select value={group.lane} disabled={busy || !lanes.length} onChange={(event) => patch(group.project.id, { lane: event.target.value })}>
                  {lanes.map((lane) => <option key={lane.value} value={lane.value}>{lane.label}</option>)}
                </select>
              </label>}
              {!lanes.length && <p className="board-placement-note">No visible lanes. Show a lane on this project’s board first.</p>}
              {eligible.length > 1000 && <p className="board-placement-note">Select at most 1,000 issues per project.</p>}
            </>}
            <ErrorNotice error={group.error} />
            {!group.sent && (group.error || !group.board || !lanes.length) && <Button type="button" variant="secondary" disabled={busy} onClick={() => { if (controller.current) void load(group, controller.current.signal); }}>Reload lanes for {group.project.name}</Button>}
          </>}
        </section>;
      })}
      {notice && <Notification message={notice} />}
      <ErrorNotice error={warning} />
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => !submitting.current && onClose()}>{hasSuccess ? "Done" : "Cancel"}</Button>
        <Button disabled={busy || !count || groups.some((group) => group.loading)}>{busy ? "Sending…" : hasSuccess && count ? `Send ${count} remaining to board` : "Send to board"}</Button>
      </div>
    </form>
  </Modal>;
}
