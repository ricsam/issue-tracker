import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Archive,
  CircleCheck,
  MessageSquare,
  RotateCcw,
  Save,
  Plus,
} from "lucide-react";
import type {
  Issue,
  IssueDetail,
  IssueState,
  IssueCloseReason,
  Comment,
  BoardSettings,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { useIssueBreadcrumb } from "../lib/issue-breadcrumb";
import { useWorkspace, issuePath, projectPath, useWorkspaceDraftGuard } from "../lib/workspace";
import { Button, ErrorNotice, Loading } from "../components/ui/primitives";
import { useNotification } from "../components/ui/snackbar";
import { IssuePlacementControls } from "../components/issue-placement-controls";
import { ExternalLinks, PluginIssueActions } from "../components/plugin-issue";
import { ShareIssue } from "../components/share-issue";
import { CopyIssueBody } from "../components/copy-issue-body";
import { IssueHistory } from "../components/issue-history";
import { IssueRelationshipsSection } from "../components/issue-relationships";
import { RichEditor } from "../components/rich-editor";
import { Markdown } from "../components/markdown";
import { IssueStateBadge } from "../components/lifecycle";
import { CloseIssueButton } from "../components/close-issue-button";
import { closeReasonLabels } from "../lib/issue-close-reasons";
import { CommentItem } from "./comment";
import { CreateIssueDialog } from "../components/create-issue-dialog";
import { NEW_ISSUE_KEYS, SAVE_ISSUE_KEYS, newIssueTooltip, saveIssueTooltip, useIssueSaveShortcut } from "../lib/issue-shortcuts";
import { useIssueCreationHandler } from "../lib/issue-creation";
import { useProjectTags } from "../lib/issue-tags";
import {
  validateBody,
  validateIssueBody,
} from "../lib/validation";

import "./issue-loading.css";
import "./issue-detail.css";

function DuplicateIssueLink({ id }: { id: string }) {
  const [target, setTarget] = useState<Issue | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<IssueDetail>(`/api/issues/${id}`, { signal: controller.signal }).then(result => setTarget(result.issue)).catch(() => {});
    return () => controller.abort();
  }, [id]);
  return target ? <Link to={issuePath(target)}>!{target.number}</Link> : <span>an unavailable issue</span>;
}

export function DetailPage() {
  const { number, workspaceSlug } = useParams();
  return <IssueDetails key={`${workspaceSlug}:${number}`} id={number || ""} byNumber />;
}

type IssueDetailsProps = {
  id: string;
  byNumber?: boolean;
  embedded?: boolean;
  panelActions?: ReactNode;
  boards?: Record<string, BoardSettings>;
  existingTags?: string[];
  onSaved?: (issue: Issue) => void;
  onCreated?: (issue: Issue) => void;
  onRelationshipsChanged?: () => void;
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
  const current = props.byNumber ? String(detail?.issue.number) === id : detail?.issue.id === id;
  const error = request?.id === id ? request.error : "";
  const loading = !current && !error;
  const stale = !!detail && !current;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRequest(null);
    // A rapid switch back to the still-mounted issue needs no new request.
    if (current) return;
    api<IssueDetail>(`/api/issues/${props.byNumber ? "by-number/" : ""}${id}`, { signal: controller.signal })
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
      {(!detail || stale) && props.embedded && <header className="issue-detail-header">
        <strong>{loading ? "Loading issue…" : "Issue unavailable"}</strong>
        <div className="issue-window-actions">{props.panelActions}</div>
      </header>}
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
  onCreated,
  onRelationshipsChanged,
  onBoardChanged,
  onPendingChange,
  initialDetail,
  existingTags,
  panelActions,
  boards,
}: IssueDetailsProps & { initialDetail: IssueDetail }) {
  const { users, projects, refresh } = useWorkspace();
  const [issue, setIssue] = useState<Issue>(initialDetail.issue);
  const [persisted, setPersisted] = useState<Issue>(initialDetail.issue);
  const [comments, setComments] = useState<Comment[]>(initialDetail.comments);
  const [historyRevision, setHistoryRevision] = useState(0);
  const refreshHistory = () => setHistoryRevision((value) => value + 1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const notify = useNotification();
  const [moving, setMoving] = useState(false);
  const [relating, setRelating] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [creating, setCreating] = useState(false);
  const [newTags, setNewTags] = useState<string[]>([]);
  const project = projects.find((p) => p.id === issue.projectId);
  const archived = !!project?.archivedAt || issue.access !== "full";
  const catalog = useProjectTags(project?.slug, issue.projectId === initialDetail.issue.projectId ? existingTags : undefined);
  const tags = [...new Set([...catalog, ...persisted.labels, ...newTags])];
  const dirty = issue.body !== persisted.body;
  useIssueSaveShortcut(form, dirty && !busy && !posting && !changingState && !moving && !relating && !archived, id);
  useIssueCreationHandler(() => setCreating(true), !embedded);
  const setBreadcrumb = useIssueBreadcrumb();
  useEffect(() => {
    if (embedded) return;
    setBreadcrumb(persisted);
    return () => setBreadcrumb(null);
  }, [embedded, persisted, setBreadcrumb]);
  const pending = dirty || !!comment.trim() || busy || posting || changingState || moving || relating;
  useWorkspaceDraftGuard(pending);
  // The post-creation toast can outlive its dialog; always guard the latest draft.
  const currentPending = useRef(pending);
  currentPending.current = pending;
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  function update(p: Partial<Issue>) {
    setIssue((v) => (v ? { ...v, ...p } : v));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || submitting.current || busy || posting || changingState || moving || relating || archived || form.current?.closest("[inert]")) return;
    submitting.current = true;
    setBusy(true);
    setError("");
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
      refreshHistory();
      onSaved?.(result.issue);
      notify("Changes saved");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  // Lifecycle actions preserve unsaved body edits. A close can post the comment atomically.
  function lifecycleChanged(updated: Issue) {
    const { state, closedAt, closedById, closeReason, duplicateOfId, updatedAt, taggedUserIds } = updated;
    const lifecycle = { state, closedAt, closedById, closeReason, duplicateOfId, updatedAt, taggedUserIds };
    setIssue((current) => ({ ...current, ...lifecycle }));
    setPersisted((current) => ({ ...current, ...lifecycle }));
    refreshHistory();
    onSaved?.(updated);
  }
  async function closeIssue(reason: IssueCloseReason, duplicateOfId?: string) {
    if (submitting.current || busy || posting || changingState || moving || relating || archived || issue.state !== "open") return false;
    submitting.current = true;
    setChangingState(true);
    setError("");
    try {
      if (comment.trim()) validateBody(comment);
      const result = await api<{ issue: Issue; comment?: Comment }>(`/api/issues/${id}/close`, {
        method: "POST",
        body: JSON.stringify({ reason, duplicateOfId, ...(comment.trim() ? { comment } : {}) }),
      });
      if (result.comment) setComments((current) => [...current, result.comment!]);
      setComment("");
      lifecycleChanged(result.issue);
      notify(result.comment ? "Issue closed with comment" : "Issue closed");
      void refresh().catch((cause) => setError(`Issue closed, but workspace counts could not refresh: ${message(cause)}`));
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      submitting.current = false;
      setChangingState(false);
    }
  }
  async function changeState(state: IssueState) {
    if (submitting.current || busy || posting || changingState || moving || relating || archived || (issue.state === "draft" && dirty)) return;
    submitting.current = true;
    setChangingState(true);
    setError("");
    try {
      const result = await api<{ issue: Issue }>(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
      lifecycleChanged(result.issue);
      notify(issue.state === "draft" ? "Issue published" : state === "closed" ? "Issue closed" : "Issue reopened");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      submitting.current = false;
      setChangingState(false);
    }
  }
  function commentIssueChanged(updated: Issue) {
    refreshHistory();
    // Comment mentions update associations without replacing an unsaved issue draft.
    setIssue((current) => current ? { ...current, taggedUserIds: updated.taggedUserIds } : current);
    setPersisted((current) => current ? { ...current, taggedUserIds: updated.taggedUserIds } : current);
    onSaved?.(updated);
  }
  async function post(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim() || submitting.current || busy || posting || changingState || moving || relating || archived) return;
    submitting.current = true;
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
      submitting.current = false;
      setPosting(false);
    }
  }
  const draft = issue.state === "draft";
  const closed = issue.state === "closed";
  const closer = users.find((u) => u.id === issue.closedById)?.name;
  return (
    <div className="detail-container">
      {archived && (
        <p className="read-only-note">
          <Archive size={15} />
          <span>
            {project?.archivedAt ? "This issue belongs to an archived project and is read-only." : "You have read-only access to this issue."}{" "}
            {!embedded && project?.archivedAt && project.access === "full" && (
              <Link to={projectPath(project)}>
                Restore the project to make changes.
              </Link>
            )}
          </span>
        </p>
      )}
      <ErrorNotice error={error} />
      <form ref={form} onSubmit={save} className="detail-form">
        <header className="issue-detail-header">
          <div className="detail-title">
            <h2><Link className="issue-permalink" to={issuePath(issue)} onClick={(event) => {
              if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
                && currentPending.current && !window.confirm("Discard unsaved issue changes or comment?")) event.preventDefault();
            }}>ISSUE !{issue.number}</Link></h2>
            <IssueStateBadge state={issue.state} closeReason={issue.closeReason} />
            <IssuePlacementControls issue={persisted} board={issue.projectId ? boards?.[issue.projectId] : undefined}
              disabled={archived || busy || changingState || posting || relating} onBusyChange={setMoving}
              onMoved={(updated) => {
                setIssue((current) => ({ ...updated, body: current.body }));
                setPersisted(updated);
                refreshHistory();
                setNewTags([]);
                onSaved?.(updated);
                notify("Issue moved");
              }}
              onBoardChanged={(projectId, board) => { refreshHistory(); onBoardChanged?.(projectId, board); notify("Board placement updated"); }} />
          </div>
          <div className="issue-window-actions">{!draft && <ShareIssue issue={issue} />}{panelActions}</div>
        </header>
        {!archived && <PluginIssueActions issue={persisted} comments={comments} />}
        <ExternalLinks issue={persisted} />
        {draft && <p className="read-only-note">Only you can see this draft, while you have access to its project. Publishing shares the saved issue, comments and history with everyone who has access and cannot be undone. Save any changes before publishing.</p>}
        <fieldset
          disabled={busy || changingState}
          inert={busy || changingState}
          className={archived ? "is-read-only" : undefined}
        >
          <div className="detail-heading">
              <small className="issue-created-meta muted">
                Created <time dateTime={issue.createdAt}>{new Date(issue.createdAt).toLocaleDateString()}</time>
                {" · by "}{users.find((u) => u.id === issue.authorId)?.name || "a teammate"}
                {issue.closedAt && <> · Closed as {closeReasonLabels[issue.closeReason ?? "completed"].toLowerCase()} {new Date(issue.closedAt).toLocaleDateString()}{closer && ` by ${closer}`}
                  {issue.duplicateOfId && <> · Duplicate of <DuplicateIssueLink id={issue.duplicateOfId} /></>}
                </>}
              </small>
            {!archived && (
              <div className="save-actions">
                {!embedded && <Button type="button" variant="secondary" onClick={() => setCreating(true)} title={newIssueTooltip()} aria-keyshortcuts={NEW_ISSUE_KEYS}>
                  <Plus size={15} /> Create issue
                </Button>}
                {draft && <Button type="button" variant="secondary"
                  disabled={busy || posting || changingState || moving || relating || dirty}
                  onClick={() => void changeState("open")}>
                  <CircleCheck size={15} />{changingState ? "Publishing…" : "Publish issue"}
                </Button>}
                <Button type="button" variant="secondary" disabled={!dirty || busy || posting || changingState || moving || relating} onClick={() => { update({ body: persisted.body }); notify("Body changes discarded"); }}>Discard changes</Button>
                <Button disabled={!dirty || busy || posting || changingState || moving || relating} title={saveIssueTooltip()} aria-keyshortcuts={SAVE_ISSUE_KEYS}>
                  <Save size={15} />
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </div>
          <div className="issue-detail-body">
              {archived ? (
                <div className="rich-editor">
                  <div className="editor-topbar">
                    <span className="muted">Preview</span>
                    <CopyIssueBody body={issue.body} iconOnly />
                  </div>
                  <article className="issue-read-only" aria-label="Issue">
                    <Markdown mentionUsers={users}>{issue.body}</Markdown>
                  </article>
                </div>
              ) : (
                <RichEditor
                  value={issue.body}
                  onChange={(body) => update({ body })}
                  mentionUsers={users}
                  existingTags={tags}
                  ariaLabel="Issue"
                  initialMode="preview"
                  toolbarActions={<CopyIssueBody body={issue.body} iconOnly />}
                  previewEditOnDoubleClick
                  placeholder="What needs to happen? Just start writing…"
                />
              )}
          </div>
        </fieldset>
      </form>
      {!draft && <IssueRelationshipsSection issue={persisted} readOnly={archived} disabled={busy || changingState || moving || posting}
        revision={historyRevision} onChanged={() => { refreshHistory(); onRelationshipsChanged?.(); }} onBusyChange={setRelating}
        canNavigate={() => !currentPending.current || window.confirm("Discard unsaved issue changes or comment?")}
        onCreated={(created) => {
          onCreated?.(created);
          if (created.projectId === persisted.projectId) setNewTags((current) => [...new Set([...current, ...created.labels])]);
          if (!onCreated) void refresh().catch((cause) => setError(`Sub-issue created, but workspace counts could not refresh: ${message(cause)}`));
        }} onBoardChanged={onBoardChanged} />}
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
            <fieldset disabled={posting || changingState || busy || moving || relating}>
              <legend className="sr-only">Add a comment</legend>
              <div inert={posting || changingState || busy || moving || relating}>
              <RichEditor
                value={comment}
                onChange={setComment}
                mentionUsers={users}
                placeholder="Share an update or ask a question…"
                minimal
              />
              </div>
              <div className="form-actions comment-actions">
                {!draft && (closed ? <Button type="button" variant="secondary" onClick={() => void changeState("open")}>
                  <RotateCcw size={15} />{changingState ? "Reopening…" : "Reopen issue"}
                </Button> : <CloseIssueButton issueId={id} hasComment={!!comment.trim()}
                  disabled={posting || changingState || busy || moving || relating} closing={changingState} onClose={closeIssue} />)}
                <Button disabled={posting || !comment.trim()}>
                  {posting ? "Posting…" : "Post comment"}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
      <IssueHistory issueId={id} revision={historyRevision} />
      {creating && <CreateIssueDialog project={archived ? null : project} existingTags={archived ? undefined : tags} onBoardChanged={onBoardChanged}
        onCreated={(created) => { setNewTags((current) => [...new Set([...current, ...created.labels])]); void refresh().catch((cause) => setError(message(cause))); }}
        onClose={() => setCreating(false)}
        canViewIssue={() => !currentPending.current || window.confirm("Discard unsaved issue changes or comment?")} />}
    </div>
  );
}
