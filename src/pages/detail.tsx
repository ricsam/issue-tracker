import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Archive,
  ArrowLeft,
  CircleCheck,
  MessageSquare,
  RotateCcw,
  Save,
} from "lucide-react";
import type {
  Issue,
  IssueDetail,
  IssueState,
  Comment,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
import { Markdown } from "../components/markdown";
import { IssueStateBadge } from "../components/lifecycle";
import { CommentItem } from "./comment";
import {
  parseLabels,
  validateBody,
  validateIssueBody,
} from "../lib/validation";

import "./issue-loading.css";

export function DetailPage() {
  const { id } = useParams();
  return <IssueDetails id={id || ""} />;
}

type IssueDetailsProps = {
  id: string;
  embedded?: boolean;
  onSaved?: (issue: Issue) => void;
  onPendingChange?: (pending: boolean) => void;
};

/** Keep the last editor mounted until the next request resolves. Deferring just
 * the id would not defer effect-based network loading (there is no Suspense data
 * source here). Only a successful response replaces the keyed editor/draft. */
export function IssueDetails(props: IssueDetailsProps) {
  const { id } = props;
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [request, setRequest] = useState<{ id: string; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const current = detail?.issue.id === id;
  const error = request?.id === id ? request.error : "";
  const loading = !current && !error;
  const stale = !!detail && !current;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRequest(null);
    // A rapid switch back to the still-mounted issue needs no new request.
    if (detail?.issue.id === id) return;
    api<IssueDetail>(`/api/issues/${id}`, { signal: controller.signal })
      .then((result) => {
        if (active) {
          setDetail(result);
          setRequest({ id, error: "" });
        }
      })
      .catch((cause) => {
        if (active) setRequest({ id, error: message(cause) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, retry]);

  useLayoutEffect(() => {
    // Reset the panel scroll only when the new issue is actually ready, not
    // while the previous content is still being displayed.
    content.current?.closest(".issue-detail-scroll")?.scrollTo({ top: 0 });
  }, [detail?.issue.id]);

  return (
    <div className="issue-detail-loader" aria-busy={loading}>
      {detail && loading && (
        <div className="issue-load-progress" role="status" aria-label="Loading issue">
          <span className="sr-only">Loading issue…</span>
        </div>
      )}
      {error && (
        <div className="issue-load-error">
          <ErrorNotice error={`Could not load the selected issue: ${error}`} />
          {stale && <p className="muted">The previous issue is shown below. Select another issue or retry.</p>}
          <Button onClick={() => { setRequest(null); setRetry((value) => value + 1); }}>Retry</Button>
        </div>
      )}
      {!detail && loading && <Loading />}
      <div
        ref={content}
        className={`issue-detail-content${stale ? " is-stale" : ""}`}
        inert={stale}
      >
        {detail && (
          <IssueDetailForm
            {...props}
            key={detail.issue.id}
            id={detail.issue.id}
            initialDetail={detail}
            onPendingChange={current ? props.onPendingChange : undefined}
          />
        )}
      </div>
    </div>
  );
}

function IssueDetailForm({
  id,
  embedded = false,
  onSaved,
  onPendingChange,
  initialDetail,
}: IssueDetailsProps & { initialDetail: IssueDetail }) {
  const { users, projects, refresh } = useWorkspace();
  const [issue, setIssue] = useState<Issue>(initialDetail.issue);
  const [persisted, setPersisted] = useState<Issue>(initialDetail.issue);
  const [comments, setComments] = useState<Comment[]>(initialDetail.comments);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [saved, setSaved] = useState("");
  const [labels, setLabels] = useState(initialDetail.issue.labels.join(", "));
  const dirty =
    !!issue &&
    !!persisted &&
    (issue.body !== persisted.body ||
      labels !== persisted.labels.join(", "));
  const pending = dirty || !!comment.trim() || busy || posting || changingState;
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
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
      const { body } = issue;
      validateIssueBody(body);
      const result = await api<{ issue: Issue }>(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          body,
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
  // Close/reopen immediately without saving or discarding other unsaved edits.
  async function changeState(state: IssueState) {
    setChangingState(true);
    setError("");
    setSaved("");
    try {
      const result = await api<{ issue: Issue }>(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
      const { closedAt, closedById, updatedAt } = result.issue;
      const lifecycle = { state: result.issue.state, closedAt, closedById, updatedAt };
      setIssue((v) => (v ? { ...v, ...lifecycle } : v));
      setPersisted((v) => (v ? { ...v, ...lifecycle } : v));
      onSaved?.(result.issue);
      setSaved(state === "closed" ? "Issue closed" : "Issue reopened");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setChangingState(false);
    }
  }
  function commentIssueChanged(updated: Issue) {
    // Comment mentions update associations without replacing an unsaved issue draft.
    setIssue((current) => current ? { ...current, taggedUserIds: updated.taggedUserIds } : current);
    setPersisted((current) => current ? { ...current, taggedUserIds: updated.taggedUserIds } : current);
    onSaved?.(updated);
  }
  async function post(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    setError("");
    try {
      validateBody(comment);
      const result = await api<{ comment: Comment; issue: Issue }>(
        `/api/issues/${id}/comments`,
        { method: "POST", body: JSON.stringify({ body: comment }) },
      );
      setComments((v) => [...v, result.comment]);
      commentIssueChanged(result.issue);
      setComment("");
    } catch (e) {
      setError(message(e));
    } finally {
      setPosting(false);
    }
  }
  const project = projects.find((p) => p.id === issue.projectId);
  const archived = !!project?.archivedAt;
  const closed = issue.state === "closed";
  const closer = users.find((u) => u.id === issue.closedById)?.name;
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
      {archived && (
        <p className="read-only-note">
          <Archive size={15} />
          <span>
            This issue belongs to an archived project and is read-only.{" "}
            {!embedded && project && (
              <Link to={`/projects/${project.slug}`}>
                Restore the project to make changes.
              </Link>
            )}
          </span>
        </p>
      )}
      <ErrorNotice error={error} />
      <form onSubmit={save} className="detail-form">
        <fieldset
          disabled={busy || changingState || archived}
          className={archived ? "is-read-only" : undefined}
        >
          <div className="detail-heading">
            <div className="detail-title">
              <span className="eyebrow">ISSUE #{issue.number}</span>
              <IssueStateBadge state={issue.state} />
            </div>
            {!archived && (
              <div className="save-actions">
                <span role="status" className="success">
                  {saved}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || changingState}
                  onClick={() => void changeState(closed ? "open" : "closed")}
                >
                  {closed ? <RotateCcw size={15} /> : <CircleCheck size={15} />}
                  {changingState
                    ? closed
                      ? "Reopening…"
                      : "Closing…"
                    : closed
                      ? "Reopen issue"
                      : "Close issue"}
                </Button>
                <Button disabled={busy || changingState}>
                  <Save size={15} />
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </div>
          <div className="detail-grid">
            <section>
              {archived ? (
                <article className="issue-read-only" aria-label="Issue">
                  <Markdown mentionUsers={users}>{issue.body}</Markdown>
                </article>
              ) : (
                <RichEditor
                  value={issue.body}
                  onChange={(body) => update({ body })}
                  mentionUsers={users}
                  ariaLabel="Issue"
                  placeholder="What needs to happen? Just start writing…"
                />
              )}
            </section>
            <aside className="properties">
              <h2>Properties</h2>
              <div className="tagged-users-field">
                <span>Tagged users</span>
                <div className="tagged-users" role="list" aria-label="Tagged users">
                  {issue.taggedUserIds.length ? issue.taggedUserIds.map((id) => {
                    const user = users.find((candidate) => candidate.id === id);
                    return <span role="listitem" className="tag user-tag" key={id} title={user?.email}>{user?.name || "Unknown user"}</span>;
                  }) : <span className="muted">No tagged users</span>}
                </div>
              </div>
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
                {issue.closedAt && (
                  <span className="closed-meta">
                    Closed {new Date(issue.closedAt).toLocaleDateString()}
                    {closer && ` · by ${closer}`}
                  </span>
                )}
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
            readOnly={archived}
            onIssueChange={commentIssueChanged}
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
        {!archived && (
          <form className="form-stack" onSubmit={post}>
            <fieldset disabled={posting}>
              <legend className="field-label">Add a comment</legend>
              <RichEditor
                value={comment}
                onChange={setComment}
                mentionUsers={users}
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
        )}
      </section>
    </div>
  );
}
