import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Archive,
  CircleCheck,
  MessageSquare,
  RotateCcw,
  Save,
  Plus,
  Columns3,
} from "lucide-react";
import type {
  Issue,
  IssueDetail,
  IssueState,
  Comment,
  BoardSettings,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { useIssueBreadcrumb } from "../lib/issue-breadcrumb";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
import { Markdown } from "../components/markdown";
import { IssueStateBadge } from "../components/lifecycle";
import { CommentItem } from "./comment";
import { CreateIssueDialog } from "../components/create-issue-dialog";
import { SendToBoardDialog } from "../components/send-to-board-dialog";
import { NEW_ISSUE_KEYS, SAVE_ISSUE_KEYS, newIssueTooltip, saveIssueTooltip, useIssueSaveShortcut } from "../lib/issue-shortcuts";
import { useIssueCreationHandler } from "../lib/issue-creation";
import { useProjectTags } from "../lib/issue-tags";
import {
  validateBody,
  validateIssueBody,
} from "../lib/validation";

import "./issue-loading.css";
import "./issue-detail.css";

export function DetailPage() {
  const { id } = useParams();
  return <IssueDetails id={id || ""} />;
}

type IssueDetailsProps = {
  id: string;
  embedded?: boolean;
  existingTags?: string[];
  onSaved?: (issue: Issue) => void;
  onBoardChanged?: (projectId: string, board: BoardSettings) => void;
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
  onBoardChanged,
  onPendingChange,
  initialDetail,
  existingTags,
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
  const form = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [newTags, setNewTags] = useState<string[]>([]);
  const project = projects.find((p) => p.id === issue.projectId);
  const archived = !!project?.archivedAt;
  const catalog = useProjectTags(project?.slug, existingTags);
  const tags = [...new Set([...catalog, ...persisted.labels, ...newTags])];
  useIssueSaveShortcut(form, !busy && !changingState && !archived, id);
  useIssueCreationHandler(() => setCreating(true), !embedded);
  const setBreadcrumb = useIssueBreadcrumb();
  useEffect(() => {
    if (embedded) return;
    setBreadcrumb(persisted);
    return () => setBreadcrumb(null);
  }, [embedded, persisted, setBreadcrumb]);
  const dirty = issue.body !== persisted.body;
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
    if (submitting.current || busy || changingState || archived || form.current?.closest("[inert]")) return;
    submitting.current = true;
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
        }),
      });
      setIssue(result.issue);
      setPersisted(result.issue);
      onSaved?.(result.issue);
      setSaved("Changes saved");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      submitting.current = false;
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
  const closed = issue.state === "closed";
  const closer = users.find((u) => u.id === issue.closedById)?.name;
  return (
    <div className="detail-container">
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
      <form ref={form} onSubmit={save} className="detail-form">
        <fieldset
          disabled={busy || changingState || archived}
          inert={busy || changingState}
          className={archived ? "is-read-only" : undefined}
        >
          <div className="detail-heading">
            <div className="detail-title">
              <span className="eyebrow">ISSUE !{issue.number}</span>
              <IssueStateBadge state={issue.state} />
              <span className="muted">{project ? project.name : "No project"}</span>
              <small className="issue-created-meta muted">
                Created <time dateTime={issue.createdAt}>{new Date(issue.createdAt).toLocaleDateString()}</time>
                {" · by "}{users.find((u) => u.id === issue.authorId)?.name || "a teammate"}
                {issue.closedAt && <> · Closed {new Date(issue.closedAt).toLocaleDateString()}{closer && ` by ${closer}`}</>}
              </small>
            </div>
            {!archived && (
              <div className="save-actions">
                <span role="status" className="success">
                  {saved}
                </span>
                {!embedded && <Button type="button" variant="secondary" onClick={() => setCreating(true)} title={newIssueTooltip()} aria-keyshortcuts={NEW_ISSUE_KEYS}>
                  <Plus size={15} /> Create issue
                </Button>}
                <Button type="button" variant="secondary" disabled={busy || changingState || !project}
                  title={project ? "Add or move this issue to a board lane" : "Issues without a project have no board"}
                  onClick={() => setSending(true)}><Columns3 size={15} /> Send to board</Button>
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
                <Button disabled={busy || changingState} title={saveIssueTooltip()} aria-keyshortcuts={SAVE_ISSUE_KEYS}>
                  <Save size={15} />
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </div>
          <div className="issue-detail-body">
              {archived ? (
                <article className="issue-read-only" aria-label="Issue">
                  <Markdown mentionUsers={users}>{issue.body}</Markdown>
                </article>
              ) : (
                <RichEditor
                  value={issue.body}
                  onChange={(body) => update({ body })}
                  mentionUsers={users}
                  existingTags={tags}
                  ariaLabel="Issue"
                  initialMode="preview"
                  placeholder="What needs to happen? Just start writing…"
                />
              )}
          </div>
        </fieldset>
      </form>
      <section className="comments">
        {comments.length > 0 && <h2>
          <MessageSquare size={18} /> Discussion{" "}
          <span className="count">{comments.length}</span>
        </h2>}
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
              <legend className="sr-only">Add a comment</legend>
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
      {sending && <SendToBoardDialog issues={[persisted]} onClose={() => setSending(false)}
        onPlaced={(projectId, board) => { onBoardChanged?.(projectId, board); setSaved("Board placement updated"); }} />}
      {creating && <CreateIssueDialog project={archived ? null : project} existingTags={archived ? undefined : tags}
        onCreated={(created) => { setNewTags((current) => [...new Set([...current, ...created.labels])]); void refresh().catch((cause) => setError(message(cause))); }}
        onClose={() => setCreating(false)}
        canViewIssue={() => !pending || window.confirm("Discard unsaved issue changes or comment?")} />}
    </div>
  );
}
