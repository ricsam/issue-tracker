import { useId, useRef, useState, type FormEvent } from "react";
import type { Issue } from "../../shared/types";
import { extractIssueLabels, labelMarkdown } from "../../shared/labels";
import { api, message } from "../lib/api";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import "./bulk-tag-dialog.css";

export function BulkLabelDialog({ slug, issueIds, existingLabels, onSaved, onClose }: {
  slug: string;
  issueIds: string[];
  existingLabels: string[];
  onSaved: (issues: Issue[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const entered = extractIssueLabels(input);
  const labels = [...new Set([...selected, ...entered])];
  const validation = labels.length > 30 || labels.some((label) => label.length > 50)
    ? "Use at most 30 tags, each at most 50 characters."
    : input.trim() && !entered.length ? "Start each tag with #, for example #bug #needs-review." : "";

  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || validation || !labels.length || !issueIds.length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ issues: Issue[] }>(`/api/projects/${encodeURIComponent(slug)}/issues/labels`, {
        method: "POST",
        body: JSON.stringify({ issueIds: [...new Set(issueIds)], labels }),
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
    <Modal title="Add tags" description={`Add tags to ${issueIds.length} selected issue${issueIds.length === 1 ? "" : "s"}.`} open
      onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
      onOpenChange={(open) => !open && !submitting.current && onClose()}>
      <form className="form-stack" onSubmit={save} aria-busy={busy}>
        <p className="muted">Adds tags without replacing existing text or duplicating tags.</p>
        <fieldset disabled={busy} className="bulk-tag-fields">
          <label>New tags
            <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="#bug #needs-review" aria-describedby={helpId} aria-invalid={!!validation} />
          </label>
          <small id={helpId} className="muted">Separate tags with spaces. Use #[needs review] for a tag containing spaces.</small>
          {existingLabels.length > 0 && <>
            <strong>Existing tags</strong>
            <div className="bulk-tag-options" role="group" aria-label="Existing tags">
              {existingLabels.map((label) => <label className="bulk-tag-option" key={label}>
                <input type="checkbox" checked={selected.has(label)} onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(label); else next.delete(label);
                    return next;
                  });
                }} />
                <span>{labelMarkdown(label)}</span>
              </label>)}
            </div>
          </>}
        </fieldset>
        <div className="bulk-label-preview" role="status">
          <p className="muted">{labels.length} tag{labels.length === 1 ? "" : "s"} to add</p>
          {labels.length > 0 && <div className="issue-meta">{labels.map((label) => <span className="tag" key={label}>{labelMarkdown(label)}</span>)}</div>}
        </div>
        <ErrorNotice error={validation || error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => !submitting.current && onClose()}>Cancel</Button>
          <Button disabled={busy || !!validation || !labels.length || !issueIds.length}>{busy ? "Adding…" : "Add tags"}</Button>
        </div>
      </form>
    </Modal>
  );
}
