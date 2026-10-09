import { useRef, useState, type FormEvent } from "react";
import type { Issue } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import "./move-issue-dialog.css";

export function MoveIssueDialog({ issue, onMoved, onClose, onBusyChange }: {
  issue: Issue; onMoved: (issue: Issue) => void; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const { projects } = useWorkspace();
  const [projectId, setProjectId] = useState(issue.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const changed = projectId !== (issue.projectId ?? "");
  async function move(event: FormEvent) {
    event.preventDefault();
    if (!changed || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const result = await api<{ issue: Issue }>(`/api/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ projectId: projectId || null }) });
      onMoved(result.issue);
      onClose();
    } catch (cause) { setError(message(cause)); }
    finally { submitting.current = false; setBusy(false); onBusyChange(false); }
  }
  return <Modal open title="Move issue" description="Choose a project for this issue." onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }} className="move-issue-dialog">
    <form className="form-stack" onSubmit={move} aria-busy={busy}>
      <label>Destination project<select value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">No project</option>
        {projects.filter((project) => !project.archivedAt).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <p className="muted">Moving removes any placement on the previous project’s board. It does not add this issue to the destination board. Issue identity, comments, and unsaved drafts are preserved.</p>
      <ErrorNotice error={error} />
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !changed}>{busy ? "Moving…" : "Move issue"}</Button></div>
    </form>
  </Modal>;
}
