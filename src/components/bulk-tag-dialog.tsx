import { useRef, useState, type FormEvent } from "react";
import type { Issue, User } from "../../shared/types";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import "./bulk-tag-dialog.css";

export function BulkTagDialog({ slug, issueIds, users, onSaved, onClose }: {
  slug: string;
  issueIds: string[];
  users: User[];
  onSaved: (issues: Issue[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const matches = users.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !selected.size || !issueIds.length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ issues: Issue[] }>(`/api/projects/${encodeURIComponent(slug)}/issues/tag`, {
        method: "POST",
        body: JSON.stringify({ issueIds: [...new Set(issueIds)], userIds: [...selected] }),
      });
      onSaved(result.issues);
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="Tag teammates" description={`Add @mentions to ${issueIds.length} selected issue${issueIds.length === 1 ? "" : "s"}.`} open
      onOpenChange={(open) => !open && !submitting.current && onClose()}>
      <form className="form-stack" onSubmit={save} aria-busy={busy}>
        <p className="muted">Appends mentions without replacing existing text. Existing body mentions are not duplicated. If Markdown blocks prevent appending, mentions are inserted near the top instead.</p>
        <fieldset disabled={busy} className="bulk-tag-fields">
          <label>Search teammates
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or email…" />
          </label>
          <div className="bulk-tag-options">
            {matches.map((user) => <label className="bulk-tag-option" key={user.id}>
              <input type="checkbox" checked={selected.has(user.id)} onChange={(event) => {
                const checked = event.target.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(user.id); else next.delete(user.id);
                  return next;
                });
              }} />
              <span><strong>{user.name}</strong><small className="muted">{user.email}</small></span>
            </label>)}
            {!matches.length && <p className="muted">No matching teammates.</p>}
          </div>
        </fieldset>
        <p className="muted" role="status">{selected.size} teammate{selected.size === 1 ? "" : "s"} selected</p>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => !submitting.current && onClose()}>Cancel</Button>
          <Button disabled={busy || !selected.size || !issueIds.length}>{busy ? "Tagging…" : "Add mentions"}</Button>
        </div>
      </form>
    </Modal>
  );
}
