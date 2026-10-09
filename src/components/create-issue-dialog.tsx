import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { BoardSettings, Issue, Project } from "../../shared/types";
import { orderedLanes } from "../../shared/board";
import { api, message } from "../lib/api";
import { validateIssueBody } from "../lib/validation";
import { useWorkspace } from "../lib/workspace";
import { useProjectTags } from "../lib/issue-tags";
import { CREATE_ISSUE_KEYS, createIssueTooltip, useCreateIssueShortcut, useIssueSaveShortcut } from "../lib/issue-shortcuts";
import { CopyIssueBody } from "./copy-issue-body";
import { RichEditor } from "./rich-editor";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import { Notification } from "./ui/snackbar";

export function CreateIssueDialog({
  project,
  onCreated,
  onClose,
  canViewIssue,
  onViewIssue,
  existingTags,
  onBoardChanged,
}: {
  project?: Project | null;
  existingTags?: string[];
  onCreated: (issue: Issue) => void;
  onBoardChanged?: (projectId: string, board: BoardSettings) => void;
  onClose: () => void;
  canViewIssue: () => boolean;
  onViewIssue?: (issue: Issue, source: HTMLAnchorElement) => void;
}) {
  const { users, projects } = useWorkspace();
  const [projectId, setProjectId] = useState(project?.id ?? "");
  const selectedProject = projects.find((candidate) => candidate.id === projectId);
  const [lane, setLane] = useState("");
  const [boardResult, setBoardResult] = useState<{ projectId: string; board?: BoardSettings; error?: string } | null>(null);
  const [boardRetry, setBoardRetry] = useState(0);
  const board = boardResult?.projectId === projectId ? boardResult.board : undefined;
  const boardError = boardResult?.projectId === projectId ? boardResult.error : undefined;
  useEffect(() => {
    if (!selectedProject) return;
    const controller = new AbortController();
    let active = true;
    setBoardResult(null);
    api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(selectedProject.slug)}/board`, { signal: controller.signal })
      .then(({ board }) => { if (active) setBoardResult({ projectId, board }); })
      .catch((cause) => { if (active) setBoardResult({ projectId, error: message(cause) }); });
    return () => { active = false; controller.abort(); };
  }, [projectId, selectedProject?.slug, boardRetry]);
  const catalog = useProjectTags(selectedProject?.slug, projectId === (project?.id ?? "") ? existingTags : undefined);
  const [createdTags, setCreatedTags] = useState<string[]>([]);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [created, setCreated] = useState<Issue | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const fields = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useIssueSaveShortcut(form, !busy && !!body.trim());
  useCreateIssueShortcut(form, !busy && !!body.trim());
  useEffect(() => {
    // Autofocus can scroll just the editable surface into view; keep its tabs
    // and formatting controls visible at the start of each fresh draft too.
    fields.current?.scrollTo({ top: 0 });
  }, [created]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      validateIssueBody(body);
      const { issue, board: createdBoard } = await api<{ issue: Issue; board?: BoardSettings }>(
        selectedProject ? `/api/projects/${encodeURIComponent(selectedProject.slug)}/issues` : "/api/issues",
        {
          method: "POST",
          body: JSON.stringify({ body, ...(selectedProject && lane ? { lane } : {}) }),
        },
      );
      setCreated(issue);
      setShowNotice(true);
      setBody("");
      setCreatedTags((current) => [...new Set([...current, ...issue.labels])]);
      onCreated(issue);
      if (createdBoard && issue.projectId) onBoardChanged?.(issue.projectId, createdBoard);
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function viewIssue(event: MouseEvent<HTMLAnchorElement>) {
    if (submitting.current) {
      event.preventDefault();
      return;
    }
    // New-tab/modifier clicks leave the current draft in place.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (
      (body.trim() &&
        !window.confirm("Discard the new issue draft and view the created issue?")) ||
      !canViewIssue()
    ) {
      event.preventDefault();
      return;
    }
    if (created && onViewIssue) {
      event.preventDefault();
      onViewIssue(created, event.currentTarget);
    } else {
      onClose();
    }
  }

  return (
    <Modal
      className="create-issue-dialog"
      title="Create issue"
      open
      onOpenChange={(open) => !open && !submitting.current && onClose()}
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <form ref={form} onSubmit={create} className="create-issue-form" aria-busy={busy}>
        <div ref={fields} className="create-issue-fields">
          <fieldset disabled={busy} inert={busy} className="form-stack">
            <label>Project
              <select aria-label="Project" value={projectId} onChange={(event) => { setProjectId(event.target.value); setLane(""); setCreatedTags([]); }}>
                <option value="">No project</option>
                {projects.filter((candidate) => !candidate.archivedAt).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
            {selectedProject && <div>
              <label>Board lane
                <select aria-label="Board lane" value={lane} disabled={!board}
                  onChange={(event) => setLane(event.target.value)}>
                  <option value="">Not on board</option>
                  {board && orderedLanes(board.lanes, board.customLanes).map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              {!board && !boardError && <small className="muted">Loading board lanes…</small>}
              {boardError && <>
                <ErrorNotice error={`Could not load board lanes: ${boardError}`} />
                <Button type="button" variant="ghost" onClick={() => setBoardRetry((value) => value + 1)}>Retry board lanes</Button>
              </>}
            </div>}
            <div>
              <RichEditor
                // A fresh editor clears undo history, attachments and preview/source mode,
                // and autofocuses the next draft, not just its Markdown value.
                key={created?.id || "first-draft"}
                value={body}
                onChange={setBody}
                mentionUsers={users}
                existingTags={[...new Set([...catalog, ...createdTags])]}
                ariaLabel="Issue"
                autoFocus
                placeholder="What needs to happen? Just start writing…"
              />
            </div>
          </fieldset>
        </div>
        <div className="create-issue-footer">
          <ErrorNotice error={error} />
          {/* Inside the dialog's focus trap, persistent and reachable while writing again. */}
          {created && showNotice ? (
              <Notification message={`Issue !${created.number} created. Ready for another.`}
                onDismiss={busy ? undefined : () => setShowNotice(false)}>
                <div className="issue-created-actions">
                <Link
                  to={`/issues/${created.id}`}
                  onClick={viewIssue}
                  aria-disabled={busy || undefined}
                  tabIndex={busy ? -1 : undefined}
                >
                  View issue
                </Link>
                <CopyIssueBody key={created.id} body={created.body} />
                </div>
              </Notification>
            ) : <p role="status" className="sr-only" />}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={busy}
            >
              {created ? "Done" : "Cancel"}
            </Button>
            <Button disabled={busy || !body.trim()} title={createIssueTooltip()} aria-keyshortcuts={CREATE_ISSUE_KEYS}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
