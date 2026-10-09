import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, X } from "lucide-react";
import type { Issue, Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { validateIssueBody } from "../lib/validation";
import { useWorkspace } from "../lib/workspace";
import { useProjectTags } from "../lib/issue-tags";
import { CREATE_ISSUE_KEYS, createIssueTooltip, useCreateIssueShortcut, useIssueSaveShortcut } from "../lib/issue-shortcuts";
import { CopyIssueBody } from "./copy-issue-body";
import { RichEditor } from "./rich-editor";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function CreateIssueDialog({
  project,
  onCreated,
  onClose,
  canViewIssue,
  onViewIssue,
  existingTags,
}: {
  project?: Project | null;
  existingTags?: string[];
  onCreated: (issue: Issue) => void;
  onClose: () => void;
  canViewIssue: () => boolean;
  onViewIssue?: (issue: Issue, source: HTMLAnchorElement) => void;
}) {
  const { users, projects } = useWorkspace();
  const [projectId, setProjectId] = useState(project?.id ?? "");
  const selectedProject = projects.find((candidate) => candidate.id === projectId);
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
      const { issue } = await api<{ issue: Issue }>(
        selectedProject ? `/api/projects/${encodeURIComponent(selectedProject.slug)}/issues` : "/api/issues",
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      setCreated(issue);
      setShowNotice(true);
      setBody("");
      setCreatedTags((current) => [...new Set([...current, ...issue.labels])]);
      onCreated(issue);
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
              <select aria-label="Project" value={projectId} onChange={(event) => { setProjectId(event.target.value); setCreatedTags([]); }}>
                <option value="">No project</option>
                {projects.filter((candidate) => !candidate.archivedAt).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
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
          <div role="status" aria-atomic="true">
            {created && showNotice && (
              <div className="issue-created-notice">
                <CircleCheck size={20} aria-hidden="true" />
                <div className="issue-created-message">
                  <strong>Issue !{created.number} created.</strong>
                  <span>Ready for another.</span>
                </div>
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
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss notification"
                  disabled={busy}
                  onClick={() => setShowNotice(false)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
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
