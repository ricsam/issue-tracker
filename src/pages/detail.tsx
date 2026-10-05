import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, MessageSquare, Save } from "lucide-react";
import type { Issue, IssueDetail, Comment } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
import { CommentItem } from "./comment";
import {
  parseLabels,
  validateBody,
  validateIssueBody,
} from "../lib/validation";
import { IssueFields } from "../components/issue-fields";

export function DetailPage() {
  const { id } = useParams();
  return <IssueDetails key={id} id={id || ""} />;
}

export function IssueDetails({
  id,
  embedded = false,
  onSaved,
  onPendingChange,
}: {
  id: string;
  embedded?: boolean;
  onSaved?: (issue: Issue) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { users, projects, refresh } = useWorkspace();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [persisted, setPersisted] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [saved, setSaved] = useState("");
  const [labels, setLabels] = useState("");
  const [retry, setRetry] = useState(0);
  const dirty =
    !!issue &&
    !!persisted &&
    (issue.body !== persisted.body ||
      issue.assigneeId !== persisted.assigneeId ||
      labels !== persisted.labels.join(", "));
  const pending = dirty || !!comment.trim() || busy || posting;
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSaved("");
    api<IssueDetail>(`/api/issues/${id}`)
      .then((d) => {
        if (active) {
          setIssue(d.issue);
          setPersisted(d.issue);
          setLabels(d.issue.labels.join(", "));
          setComments(d.comments);
          setComment("");
        }
      })
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id, retry]);
  function update(p: Partial<Issue>) {
    setIssue((v) => (v ? { ...v, ...p } : v));
    setSaved("");
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!issue) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const { body, assigneeId } = issue;
      validateIssueBody(body);
      const result = await api<{ issue: Issue }>(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          body,
          assigneeId,
          labels: parseLabels(labels),
        }),
      });
      setIssue(result.issue);
      setPersisted(result.issue);
      setLabels(result.issue.labels.join(", "));
      onSaved?.(result.issue);
      setSaved("Changes saved");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function post(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    setError("");
    try {
      validateBody(comment);
      const result = await api<{ comment: Comment }>(
        `/api/issues/${id}/comments`,
        { method: "POST", body: JSON.stringify({ body: comment }) },
      );
      setComments((v) => [...v, result.comment]);
      setComment("");
    } catch (e) {
      setError(message(e));
    } finally {
      setPosting(false);
    }
  }
  if (loading) return <Loading />;
  if (!issue)
    return (
      <>
        <ErrorNotice error={error} />
        <Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>
      </>
    );
  const project = projects.find((p) => p.id === issue.projectId);
  return (
    <div className="detail-container">
      {!embedded && (
        <Link
          className="back-link"
          to={project ? `/projects/${project.slug}` : "/projects"}
        >
          <ArrowLeft size={16} />
          {project?.name || "Projects"}
          <span>/</span>Issue #{issue.number}
        </Link>
      )}
      <ErrorNotice error={error} />
      <form onSubmit={save} className="detail-form">
        <fieldset disabled={busy}>
          <div className="detail-heading">
            <span className="eyebrow">ISSUE #{issue.number}</span>
            <div className="save-actions">
              <span role="status" className="success">
                {saved}
              </span>
              <Button disabled={busy}>
                <Save size={15} />
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
          <div className="detail-grid">
            <section>
              <RichEditor
                value={issue.body}
                onChange={(body) => update({ body })}
                ariaLabel="Issue"
                placeholder="What needs to happen? Just start writing…"
              />
            </section>
            <aside className="properties">
              <h2>Properties</h2>
              <IssueFields issue={issue} onChange={update} />
              <label>
                Labels
                <input
                  value={labels}
                  onChange={(e) => {
                    setLabels(e.target.value);
                    setSaved("");
                  }}
                  placeholder="Comma-separated labels"
                />
              </label>
              <small className="muted">
                Created {new Date(issue.createdAt).toLocaleDateString()}
                {" · by "}
                {users.find((u) => u.id === issue.authorId)?.name ||
                  "a teammate"}
              </small>
            </aside>
          </div>
        </fieldset>
      </form>
      <section className="comments">
        <h2>
          <MessageSquare size={18} /> Discussion{" "}
          <span className="count">{comments.length}</span>
        </h2>
        {!comments.length && (
          <p className="muted">No comments yet. Start the conversation.</p>
        )}
        {comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            onUpdate={(updated) =>
              setComments((v) =>
                v.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
            onDelete={() =>
              setComments((v) => v.filter((item) => item.id !== c.id))
            }
          />
        ))}
        <form className="form-stack" onSubmit={post}>
          <fieldset disabled={posting}>
            <legend className="field-label">Add a comment</legend>
            <RichEditor
              value={comment}
              onChange={setComment}
              placeholder="Share an update or ask a question…"
              minimal
            />
            <div className="form-actions">
              <Button disabled={posting || !comment.trim()}>
                {posting ? "Posting…" : "Post comment"}
              </Button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
