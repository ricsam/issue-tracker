import { useRef, useState, type FormEvent } from "react";
import type { Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function EditProjectDialog({ project, onSaved, onClose }: {
  project: Project;
  onSaved: (project: Project) => void;
  onClose: () => void;
}) {
  const { updateProject } = useWorkspace();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dirty = name.trim() !== project.name || description !== project.description;
  function close() {
    if (submitting.current) return;
    if (dirty && !window.confirm("Discard unsaved project changes?")) return;
    onClose();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !dirty || !name.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const changes: { name?: string; description?: string } = {};
      if (name.trim() !== project.name) changes.name = name.trim();
      if (description !== project.description) changes.description = description;
      const result = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(project.slug)}`, {
        method: "PATCH", body: JSON.stringify(changes),
      });
      // Use the committed response for all navigation/cards; no second request can turn success into failure.
      updateProject(result.project);
      onSaved(result.project);
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return <Modal title="Edit project" description="Update the project name and description. Existing links will keep working."
    open onOpenChange={(open) => !open && close()}>
    <form className="form-stack" onSubmit={save} aria-busy={busy}>
      <fieldset disabled={busy} className="form-stack">
        <label>Project name
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
        </label>
        <label>Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={10000} />
        </label>
      </fieldset>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button disabled={busy || !dirty || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
      </div>
    </form>
  </Modal>;
}
