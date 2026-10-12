import { useRef, useState, type FormEvent } from "react";
import type { Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function EditProjectDialog({ project, onSaved, onClose, rename = false, onCloseAutoFocus }: {
  project: Project;
  onSaved: (project: Project) => void;
  onClose: () => void;
  /** Show only the name, for quick renames from project menus. */
  rename?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { updateProject } = useWorkspace();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== project.name || description !== project.description;
  function close() {
    if (submitting.current) return;
    if (dirty && !window.confirm(rename ? "Discard the new project name?" : "Discard unsaved project changes?")) return;
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
  return <Modal title={rename ? "Rename project" : "Edit project"}
    description={rename ? "Existing links will keep working." : "Update the project name and description. Existing links will keep working."}
    open onOpenChange={(open) => !open && close()} onCloseAutoFocus={onCloseAutoFocus}
    onOpenAutoFocus={rename ? (event) => { event.preventDefault(); nameInput.current?.select(); } : undefined}>
    <form className="form-stack" onSubmit={save} aria-busy={busy}>
      <fieldset disabled={busy} className="form-stack">
        <label>Project name
          <input ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
        </label>
        {!rename && <label>Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={10000} />
        </label>}
      </fieldset>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button disabled={busy || !dirty || !name.trim()}>{busy ? "Saving…" : rename ? "Rename" : "Save changes"}</Button>
      </div>
    </form>
  </Modal>;
}
