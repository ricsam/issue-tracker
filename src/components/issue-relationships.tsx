import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { GitBranch, Plus, Unlink } from "lucide-react";
import type { BoardSettings, Issue, IssueReference, IssueRelationships } from "../../shared/types";
import { api, message } from "../lib/api";
import { canCreateIssues } from "../../shared/access";
import { useWorkspace, workspacePath, canCreateInWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import { useNotification } from "./ui/snackbar";
import { IssueStateBadge } from "./lifecycle";
import { CreateIssueDialog } from "./create-issue-dialog";
import "./issue-relationships.css";

export function IssueRelationshipsSection({ issue, readOnly, disabled, revision, canNavigate, onBusyChange, onChanged, onCreated, onBoardChanged }: {
  issue: Issue;
  readOnly: boolean;
  disabled: boolean;
  revision: number;
  canNavigate: () => boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => void;
  onCreated: (issue: Issue) => void;
  onBoardChanged?: (projectId: string, board: BoardSettings) => void;
}) {
  const { projects, workspace } = useWorkspace();
  const canCreate = canCreateInWorkspace(workspace) || projects.some(project => !project.archivedAt && canCreateIssues(project.access));
  const notify = useNotification();
  const [relationships, setRelationships] = useState<IssueRelationships | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const submitting = useRef(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<IssueRelationships>(`/api/issues/${issue.id}/relationships`, { signal: controller.signal });
      if (!controller.signal.aborted) setRelationships(result);
    } catch (cause) {
      if (!controller.signal.aborted) { setRelationships(null); setError(message(cause)); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [issue.id]);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load, revision, issue.projectId, issue.state]);

  async function remove(parentId: string, childId: string) {
    if (submitting.current || readOnly || disabled) return;
    submitting.current = true;
    request.current?.abort();
    setBusy(true); onBusyChange(true); setError("");
    try {
      await api<IssueRelationships>(`/api/issues/${parentId}/sub-issues/${childId}`, { method: "DELETE" });
      setRelationships((current) => current && (childId === issue.id
        ? { ...current, parent: null }
        : { ...current, subIssues: current.subIssues.filter((child) => child.id !== childId) }));
      notify("Sub-issue relationship removed");
      onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { submitting.current = false; setBusy(false); setLoading(false); onBusyChange(false); }
  }
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (submitting.current || !canNavigate()) event.preventDefault();
  }
  const children = relationships?.subIssues ?? [];
  const closed = children.filter((child) => child.state === "closed").length;
  const locked = disabled || busy || loading;
  return <section className="issue-relationships" aria-label="Issue relationships" aria-busy={loading || busy}>
    {relationships?.parent && <div className="issue-parent">
      <span className="muted">Sub-issue of</span>
      <Link to={workspacePath(issue.workspaceSlug, `/issues/${relationships.parent.number}`)} onClick={navigate}>!{relationships.parent.number} {relationships.parent.title}</Link>
      <IssueStateBadge state={relationships.parent.state} />
      {!readOnly && <Button type="button" variant="ghost" className="icon-button" title="Remove parent" aria-label="Remove parent" disabled={locked}
        onClick={() => void remove(relationships.parent!.id, issue.id)}><Unlink size={15} /></Button>}
    </div>}
    <div className="sub-issues-heading">
      <h2><GitBranch size={17} aria-hidden="true" /> Sub-issues {children.length > 0 && <span className="count">{children.length}</span>}</h2>
      <div className="sub-issues-actions">
        <Button type="button" variant="ghost" disabled={locked} onClick={() => void load()}>Refresh sub-issues</Button>
        {!readOnly && <>
          <Button type="button" variant="secondary" disabled={locked} onClick={() => setAdding(true)}>Add existing issue</Button>
          <Button type="button" variant="secondary" disabled={locked || !canCreate} onClick={() => setCreating(true)}><Plus size={14} /> Create sub-issue</Button>
        </>}
      </div>
    </div>
    <ErrorNotice error={error ? `Could not update sub-issues: ${error}` : ""} />
    {loading && <p className="muted" role="status">Loading sub-issues…</p>}
    {children.length > 0 && <>
      <div className="sub-issues-progress"><progress aria-label="Sub-issue completion" max={children.length} value={closed} /><span>{closed} of {children.length} completed</span></div>
      <ul className="sub-issues-list">{children.map((child) => <li key={child.id}>
        <IssueStateBadge state={child.state} />
        <Link to={workspacePath(issue.workspaceSlug, `/issues/${child.number}`)} onClick={navigate}><span className="muted">!{child.number}</span> {child.title}</Link>
        {!readOnly && <Button type="button" variant="ghost" className="icon-button" title="Remove sub-issue" aria-label={`Remove sub-issue !${child.number}`} disabled={locked}
          onClick={() => void remove(issue.id, child.id)}><Unlink size={15} /></Button>}
      </li>)}</ul>
    </>}
    {!loading && relationships && !children.length && <p className="muted">No sub-issues to show. Break this work into smaller issues.</p>}
    <p className="sub-issues-note muted">Only issues you can access are shown. Removing a relationship does not delete the issue. Closing an issue does not close its sub-issues.</p>
    {adding && <AddSubIssueDialog parent={issue} children={children} onClose={() => setAdding(false)} onBusyChange={onBusyChange}
      onAdded={(result) => {
        request.current?.abort(); setLoading(false); setRelationships(result); setError("");
        notify("Sub-issue added"); onChanged();
      }} />}
    {creating && <CreateIssueDialog parentIssue={issue} project={projects.find((p) => p.id === issue.projectId) ?? null}
      onCreated={(child) => {
        setRelationships((current) => current && ({ ...current, subIssues: [...current.subIssues, child] }));
        onCreated(child); onChanged();
      }} onBoardChanged={onBoardChanged} onClose={() => setCreating(false)} canViewIssue={canNavigate} />}
  </section>;
}

function AddSubIssueDialog({ parent, children, onClose, onAdded, onBusyChange }: {
  parent: Issue;
  children: IssueReference[];
  onClose: () => void;
  onAdded: (result: IssueRelationships) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; issues: IssueReference[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const loading = result?.query !== query;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ issues: IssueReference[] }>(`/api/issues/references?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then(({ issues }) => { if (!controller.signal.aborted) setResult({ query, issues }); })
        .catch((cause) => { if (!controller.signal.aborted) setResult({ query, issues: [], error: message(cause) }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, retry]);
  const options = !loading ? (result?.issues ?? []).filter((issue) => issue.id !== parent.id && issue.state !== "draft" && !children.some((child) => child.id === issue.id)) : [];
  async function add(issueId: string) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const relationships = await api<IssueRelationships>(`/api/issues/${parent.id}/sub-issues`, { method: "POST", body: JSON.stringify({ issueId }) });
      onAdded(relationships); onClose();
    } catch (cause) {
      const error = message(cause);
      setError(error === "Issue relationship conflict"
        ? "Cannot add this sub-issue: it may already have a parent, or this link would create a cycle. Remove its existing parent first, if you have access."
        : error);
    }
    finally { submitting.current = false; setBusy(false); onBusyChange(false); }
  }
  return <Modal open title="Add existing sub-issue" description="Search by title or !number. Each issue can have one parent; remove an existing parent first. Drafts cannot be linked."
    onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }} className="sub-issue-picker">
    <div className="form-stack" aria-busy={busy}>
      <label>Find an issue<input type="search" value={query} maxLength={300} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Search issues by title or !number" /></label>
      <ErrorNotice error={error || (!loading ? result?.error ?? "" : "")} />
      {!loading && result?.error && <Button type="button" variant="secondary" onClick={() => { setResult(null); setRetry((value) => value + 1); }}>Retry search</Button>}
      <div className="sub-issue-options" aria-label="Matching issues">
        {options.map((issue) => <button type="button" key={issue.id} disabled={busy} onClick={() => void add(issue.id)} aria-label={`Add !${issue.number} ${issue.title}`}>
          <IssueStateBadge state={issue.state} /><span><strong>!{issue.number}</strong> {issue.title}</span><Plus size={15} aria-hidden="true" />
        </button>)}
      </div>
      {loading ? <p role="status" className="muted">Finding issues…</p> : !options.length && !result?.error ? <p role="status" className="muted">No matching issues. Try a title or exact !number.</p> : null}
      <p className="muted">Showing up to 20 matches. Linking keeps each issue’s project and access unchanged.</p>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button></div>
    </div>
  </Modal>;
}
