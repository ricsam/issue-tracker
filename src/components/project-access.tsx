import { useRef, useState, type FormEvent } from "react";
import type { Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import "./project-access.css";

export const accessExplanation = "Public projects are available to everyone signed in to this workspace. Private projects are available only to their owner, shared users, and admins.";

export function ProjectAccessSummary({ project }: { project: Project }) {
  const { users } = useWorkspace();
  const owner = users.find((user) => user.id === project.ownerId);
  return <div className="project-access-summary" aria-label="Project access">
    <span className="tag" title={accessExplanation}>{project.visibility === "private" ? "Private" : "Public"}</span>
    <span>Owner: {owner?.name || "Unassigned"}</span>
    <span>{project.sharedUserIds.length} shared</span>
  </div>;
}

export function ProjectAccessFields({ visibility, onVisibilityChange, sharedUserIds, onSharedChange, ownerId }: {
  visibility: Project["visibility"];
  onVisibilityChange: (value: Project["visibility"]) => void;
  sharedUserIds: string[];
  onSharedChange: (ids: string[]) => void;
  ownerId: string | null;
}) {
  const { users } = useWorkspace();
  return <>
    <label>Visibility
      <select value={visibility} onChange={(event) => onVisibilityChange(event.target.value as Project["visibility"])}>
        <option value="public">Public — signed-in workspace</option>
        <option value="private">Private — owner, shared users, and admins</option>
      </select>
    </label>
    <p className="muted access-explanation">{accessExplanation}</p>
    <fieldset className="project-share-list">
      <legend>Shared users</legend>
      <p className="muted access-explanation">Selected users keep access when this project is private. The owner and admins always have access.</p>
      {users.filter((user) => user.id !== ownerId && user.role !== "admin").map((user) => <label key={user.id}>
        <input type="checkbox" checked={sharedUserIds.includes(user.id)} onChange={(event) => onSharedChange(event.target.checked ? [...sharedUserIds, user.id] : sharedUserIds.filter((id) => id !== user.id))} />
        <span>{user.name} <small className="muted">({user.email})</small></span>
      </label>)}
    </fieldset>
  </>;
}

export function ProjectAccessDialog({ project, onSaved, onClose }: {
  project: Project;
  onSaved: (project: Project, refreshFailed: boolean) => void;
  onClose: () => void;
}) {
  const { users, user, updateProject, refresh } = useWorkspace();
  const [visibility, setVisibility] = useState(project.visibility);
  const [ownerId, setOwnerId] = useState(project.ownerId || "");
  const [sharedUserIds, setSharedUserIds] = useState(project.sharedUserIds);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dirty = visibility !== project.visibility || ownerId !== (project.ownerId || "") || [...sharedUserIds].sort().join() !== [...project.sharedUserIds].sort().join();
  const losesAccess = visibility === "private" && user.role !== "admin" && ownerId !== user.id && !sharedUserIds.includes(user.id);
  function close() {
    if (submitting.current) return;
    if (dirty && !window.confirm("Discard unsaved access changes?")) return;
    onClose();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !dirty) return;
    if (losesAccess && !window.confirm("You will lose access to this private project. Save access changes?")) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const changes: Partial<Pick<Project, "visibility" | "ownerId" | "sharedUserIds">> = {};
      if (visibility !== project.visibility) changes.visibility = visibility;
      if (ownerId !== (project.ownerId || "")) changes.ownerId = ownerId;
      if (JSON.stringify(sharedUserIds) !== JSON.stringify(project.sharedUserIds)) changes.sharedUserIds = sharedUserIds;
      const { project: saved } = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(project.slug)}/access`, { method: "PATCH", body: JSON.stringify(changes) });
      // Immediately remove inaccessible projects from navigation, even if refresh fails.
      updateProject(saved);
      let refreshFailed = false;
      try { await refresh(); } catch { refreshFailed = true; }
      onSaved(saved, refreshFailed);
      onClose();
    } catch (cause) { setError(message(cause)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title="Manage project access" description="Only the project owner and admins can change access, including for archived projects." open onOpenChange={(open) => !open && close()}>
    <form className="form-stack" onSubmit={save} aria-busy={busy}>
      <fieldset className="form-stack" disabled={busy}>
        <label>Project owner
          <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            {!project.ownerId && <option value="" disabled>Unassigned</option>}
            {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
          </select>
        </label>
        <ProjectAccessFields visibility={visibility} onVisibilityChange={setVisibility} sharedUserIds={sharedUserIds} onSharedChange={setSharedUserIds} ownerId={ownerId} />
      </fieldset>
      {losesAccess && <p role="status">Saving will remove your access and return you to the project list. Select yourself under Shared users to keep access.</p>}
      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button disabled={busy || !dirty}>{busy ? "Saving…" : "Save access"}</Button>
      </div>
    </form>
  </Modal>;
}
