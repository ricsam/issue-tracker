import { useState } from "react";
import type { Comment, Issue } from "../../shared/types";
import { useWorkspace } from "../lib/workspace";
import { api, message } from "../lib/api";
import { validateBody } from "../lib/validation";
import { RichEditor } from "../components/rich-editor";
import { Markdown } from "../components/markdown";
import { Button, ErrorNotice, Modal } from "../components/ui/primitives";
export function CommentItem({
  comment,
  readOnly = false,
  onUpdate,
  onDelete,
  onIssueChange,
}: {
  comment: Comment;
  /** Archived projects keep comments visible but not editable. */
  readOnly?: boolean;
  onUpdate: (comment: Comment) => void;
  onDelete: () => void;
  onIssueChange: (issue: Issue) => void;
}) {
  const { user, users } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const author = users.find((u) => u.id === comment.authorId);
  const allowed =
    !readOnly && (user.id === comment.authorId || user.role === "admin");
  async function save() {
    setBusy(true);
    setError("");
    try {
      validateBody(body);
      const result = await api<{ comment: Comment; issue: Issue }>(
        `/api/comments/${comment.id}`,
        { method: "PATCH", body: JSON.stringify({ body }) },
      );
      onUpdate(result.comment);
      onIssueChange(result.issue);
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ issue: Issue }>(`/api/comments/${comment.id}`, { method: "DELETE" });
      onDelete();
      onIssueChange(result.issue);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="comment">
      <span className="avatar">{author?.name.slice(0, 1) || "?"}</span>
      <div>
        <header>
          <strong>{author?.name || "Teammate"}</strong>
          <time dateTime={comment.createdAt}>
            {new Date(comment.createdAt).toLocaleString()}
          </time>
        </header>
        {!deleting && <ErrorNotice error={error} />}{" "}
        {editing ? (
          <>
            <RichEditor
              value={body}
              onChange={setBody}
              mentionUsers={users}
              minimal
              placeholder="Edit comment…"
            />
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel edit
              </Button>
              <Button
                disabled={busy || !body.trim()}
                onClick={() => void save()}
              >
                Save comment
              </Button>
            </div>
          </>
        ) : (
          <>
            <Markdown mentionUsers={users}>{comment.body}</Markdown>
            {allowed && (
              <div className="form-actions">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setBody(comment.body);
                    setError("");
                    setEditing(true);
                  }}
                >
                  Edit comment
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError("");
                    setDeleting(true);
                  }}
                >
                  Delete comment
                </Button>
              </div>
            )}
          </>
        )}
        <Modal
          title="Delete comment?"
          description="This removes the comment from the discussion and cannot be undone. Its content remains in the issue’s change history."
          open={deleting}
          onOpenChange={(v) => !busy && setDeleting(v)}
        >
          <ErrorNotice error={error} />
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Confirm delete"}
            </Button>
          </div>
        </Modal>
      </div>
    </article>
  );
}
