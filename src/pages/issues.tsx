import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Columns3,
  List,
  Plus,
  Search,
  Inbox,
  GripVertical,
} from "lucide-react";
import {
  STATUSES,
  PRIORITIES,
  type Issue,
  type Project,
  type Status,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { parseLabels, validateBody } from "../lib/validation";
import { useWorkspace } from "../lib/workspace";
import {
  Button,
  ErrorNotice,
  Loading,
  Modal,
} from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
export function IssueFields({
  issue,
  onChange,
}: {
  issue: Pick<Issue, "status" | "priority" | "assigneeId">;
  onChange: (patch: Partial<Issue>) => void;
}) {
  const { users } = useWorkspace();
  return (
    <div className="issue-fields">
      <label>
        Status
        <select
          value={issue.status}
          onChange={(e) =>
            onChange({ status: e.target.value as Issue["status"] })
          }
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select
          value={issue.priority}
          onChange={(e) =>
            onChange({ priority: e.target.value as Issue["priority"] })
          }
        >
          {PRIORITIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Assignee
        <select
          value={issue.assigneeId || ""}
          onChange={(e) => onChange({ assigneeId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function IssuesPage() {
  const { slug } = useParams();
  const { refresh, users } = useWorkspace();
  const navigate = useNavigate();
  const board = useLocation().pathname.endsWith("/board");
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");
  const [body, setBody] = useState("");
  const [fields, setFields] = useState<
    Pick<Issue, "status" | "priority" | "assigneeId">
  >({ status: "backlog", priority: "none", assigneeId: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api<{ project: Project }>(
        `/api/projects/${encodeURIComponent(slug || "")}`,
      ),
      api<{ issues: Issue[] }>(
        `/api/projects/${encodeURIComponent(slug || "")}/issues`,
      ),
    ])
      .then(([p, i]) => {
        if (active) {
          setProject(p.project);
          setIssues(i.issues);
        }
      })
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slug, retry]);
  async function move(issue: Issue, next: Status) {
    if (saving || issue.status === next) return;
    setSaving(issue.id);
    setError("");
    try {
      const result = await api<{ issue: Issue }>(`/api/issues/${issue.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      setIssues((current) =>
        current.map((i) => (i.id === issue.id ? result.issue : i)),
      );
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(null);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setCreateError("");
    const data = new FormData(e.currentTarget);
    try {
      validateBody(body);
      const { issue } = await api<{ issue: Issue }>(
        `/api/projects/${encodeURIComponent(slug || "")}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            title: data.get("title"),
            body,
            ...fields,
            labels: parseLabels(String(data.get("labels") || "")),
          }),
        },
      );
      await refresh();
      setOpen(false);
      navigate(`/issues/${issue.id}`);
    } catch (e) {
      setCreateError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!project)
    return (
      <>
        <ErrorNotice error={error} />
        <Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>
      </>
    );
  const filtered = issues.filter(
    (i) =>
      (status === "all" || i.status === status) &&
      `${i.title} ${i.number} ${i.labels.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function issueCard(i: Issue) {
    return (
      <article
        key={i.id}
        className={board ? "board-card" : "issue-row"}
        draggable={board && !saving}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", i.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {board && <GripVertical size={14} className="drag-hint" />}
        <Link className="issue-link" to={`/issues/${i.id}`}>
          <span className="issue-number">#{i.number}</span>
          <strong>{i.title}</strong>
        </Link>
        <div className="issue-meta">
          {i.labels.slice(0, 3).map((l) => (
            <span className="tag" key={l}>
              {l}
            </span>
          ))}
          {i.priority !== "none" && (
            <span className={`priority priority-${i.priority}`}>
              {i.priority}
            </span>
          )}
          <span
            className="avatar small"
            title={
              users.find((u) => u.id === i.assigneeId)?.name || "Unassigned"
            }
          >
            {users.find((u) => u.id === i.assigneeId)?.name.slice(0, 1) || "–"}
          </span>
          <select
            aria-label={`Status for issue #${i.number}: ${i.title}`}
            className="compact-select"
            value={i.status}
            disabled={!!saving}
            onChange={(e) => void move(i, e.target.value as Status)}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </article>
    );
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">PROJECT</span>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.description || "Every step forward starts here."}
          </p>
        </div>
        <Button
          onClick={() => {
            setBody("");
            setFields({
              status: "backlog",
              priority: "none",
              assigneeId: null,
            });
            setCreateError("");
            setOpen(true);
          }}
        >
          <Plus size={16} />
          Create issue
        </Button>
      </header>
      <div className="filter-bar">
        <div className="view-toggle">
          <Link className={!board ? "active" : ""} to={`/projects/${slug}`}>
            <List size={16} />
            List
          </Link>
          <Link
            className={board ? "active" : ""}
            to={`/projects/${slug}/board`}
          >
            <Columns3 size={16} />
            Board
          </Link>
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search issues"
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="muted results-count">{filtered.length} issues</span>
      </div>
      <ErrorNotice error={error} />
      {board ? (
        <>
          <p className="sr-only">
            Drag issues between columns, or use each issue’s status menu.
          </p>
          <div className="board">
            {STATUSES.map((s) => (
              <section
                className="board-column"
                key={s.value}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const i = issues.find(
                    (i) => i.id === e.dataTransfer.getData("text/plain"),
                  );
                  if (i) void move(i, s.value);
                }}
              >
                <h2>
                  <span className={`status-dot ${s.value}`} />
                  {s.label}
                  <span className="count">
                    {filtered.filter((i) => i.status === s.value).length}
                  </span>
                </h2>
                {filtered.filter((i) => i.status === s.value).map(issueCard)}
                {!filtered.some((i) => i.status === s.value) && (
                  <p className="column-empty">No issues here yet</p>
                )}
              </section>
            ))}
          </div>
        </>
      ) : filtered.length ? (
        <div className="issue-list">{filtered.map(issueCard)}</div>
      ) : (
        <section className="empty-state compact">
          <Inbox size={32} />
          <h2>{issues.length ? "No matching issues" : "A clean slate"}</h2>
          <p>
            {issues.length
              ? "Try a different search or status filter."
              : "Create your first issue and start making progress."}
          </p>
        </section>
      )}
      <Modal
        title="Create issue"
        description={`Add a next step to ${project.name}.`}
        open={open}
        onOpenChange={(v) => !busy && setOpen(v)}
      >
        <form onSubmit={create} className="form-stack">
          <label>
            Issue title
            <input
              name="title"
              required
              placeholder="What needs to happen?"
              maxLength={300}
            />
          </label>
          <div>
            <span className="field-label">Description</span>
            <RichEditor
              value={body}
              onChange={setBody}
              placeholder="Add context, a checklist, or attachments…"
            />
          </div>
          <IssueFields
            issue={fields}
            onChange={(p) => setFields((v) => ({ ...v, ...p }))}
          />
          <label>
            Labels
            <input name="labels" placeholder="bug, design (comma-separated)" />
          </label>
          <ErrorNotice error={createError} />
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
