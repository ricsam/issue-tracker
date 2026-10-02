import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Columns3,
  List,
  Plus,
  Search,
  Inbox,
  GripVertical,
  SlidersHorizontal,
} from "lucide-react";
import {
  STATUSES,
  PRIORITIES,
  type Issue,
  type Project,
  type Status,
  type BoardSettings,
} from "../../shared/types";
import { api, message } from "../lib/api";
import { parseLabels, validateIssueBody } from "../lib/validation";
import { useWorkspace } from "../lib/workspace";
import {
  Button,
  ErrorNotice,
  Loading,
  Modal,
} from "../components/ui/primitives";
import { RichEditor } from "../components/rich-editor";
import { BoardSettingsDialog } from "../components/board-settings";
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
  return <ProjectIssues key={slug} slug={slug || ""} />;
}

function ProjectIssues({ slug }: { slug: string }) {
  const { refresh, users } = useWorkspace();
  const navigate = useNavigate();
  const board = useLocation().pathname.endsWith("/board");
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [boardSettings, setBoardSettings] = useState<BoardSettings>({
    lanes: STATUSES.map((status) => status.value),
    issueIds: null,
  });
  const [configureBoard, setConfigureBoard] = useState(false);
  const [addToBoard, setAddToBoard] = useState(false);
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
      api<{ board: BoardSettings }>(
        `/api/projects/${encodeURIComponent(slug)}/board`,
      ),
    ])
      .then(([p, i, b]) => {
        if (active) {
          setProject(p.project);
          setIssues(i.issues);
          setBoardSettings(b.board);
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
      validateIssueBody(body);
      const { issue } = await api<{ issue: Issue }>(
        `/api/projects/${encodeURIComponent(slug || "")}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            ...fields,
            addToBoard,
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
  const lanes = STATUSES.filter((s) => boardSettings.lanes.includes(s.value));
  const selectedIds =
    boardSettings.issueIds === null ? null : new Set(boardSettings.issueIds);
  const boardIssues = issues.filter(
    (i) => selectedIds === null || selectedIds.has(i.id),
  );
  const hiddenCount = boardIssues.filter(
    (i) => !boardSettings.lanes.includes(i.status),
  ).length;
  const filtered = (board ? boardIssues : issues).filter(
    (i) =>
      (!board || boardSettings.lanes.includes(i.status)) &&
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
              status: board ? boardSettings.lanes[0] : "backlog",
              priority: "none",
              assigneeId: null,
            });
            setCreateError("");
            setAddToBoard(board);
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
        {board && (
          <Button variant="secondary" onClick={() => setConfigureBoard(true)}>
            <SlidersHorizontal size={15} /> Configure board
          </Button>
        )}
        <span className="muted results-count">{filtered.length} issues</span>
      </div>
      <ErrorNotice error={error} />
      {board ? (
        <>
          <div className="board-summary">
            <p className="muted">
              {selectedIds === null
                ? "All project issues"
                : `${boardIssues.length} selected issues`}
              {` · ${lanes.length} lanes`}
              {hiddenCount > 0 && ` · ${hiddenCount} issues in hidden lanes`}
            </p>
            {selectedIds !== null && boardIssues.length === 0 && (
              <p>
                No issues selected. Use Configure board to add issues, or create
                one for this board.
              </p>
            )}
            {boardIssues.length > 0 && filtered.length === 0 && (
              <p>
                No visible issues. Check your search, status filter, or selected
                lanes.
              </p>
            )}
          </div>
          <p className="sr-only">
            Drag issues between columns, or use each issue’s status menu.
          </p>
          <div
            className="board"
            style={{ "--board-lanes": lanes.length } as CSSProperties}
          >
            {lanes.map((s) => (
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
      {configureBoard && (
        <BoardSettingsDialog
          slug={slug}
          settings={boardSettings}
          issues={issues}
          onSaved={setBoardSettings}
          onClose={() => setConfigureBoard(false)}
        />
      )}
      <Modal
        className="create-issue-dialog"
        title="Create issue"
        description={`Add a next step to ${project.name}.`}
        open={open}
        onOpenChange={(v) => !busy && setOpen(v)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <form onSubmit={create} className="form-stack">
          <div>
            <RichEditor
              value={body}
              onChange={setBody}
              ariaLabel="Issue"
              autoFocus
              placeholder="What needs to happen? Just start writing…"
            />
            <p className="settings-help muted">
              Write your issue in one place. A heading or the first line becomes
              its title on the board.
            </p>
          </div>
          <IssueFields
            issue={fields}
            onChange={(p) => setFields((v) => ({ ...v, ...p }))}
          />
          <label>
            Labels
            <input name="labels" placeholder="bug, design (comma-separated)" />
          </label>
          {boardSettings.issueIds !== null && (
            <div>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={addToBoard}
                  onChange={(e) => setAddToBoard(e.target.checked)}
                />
                Add to board
              </label>
              {addToBoard && !boardSettings.lanes.includes(fields.status) && (
                <p className="settings-help muted">
                  This issue’s status is in a hidden lane. It will be selected,
                  but not visible until that lane is shown.
                </p>
              )}
            </div>
          )}
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
            <Button disabled={busy || !body.trim()}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
