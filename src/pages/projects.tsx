import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Archive, ArrowUpRight, FolderKanban, Plus } from "lucide-react";
import type { Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "../components/ui/primitives";
import { FavoriteProjectButton } from "../components/favorite-projects";
export function ProjectsPage() {
  const { projects, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const archivedView = useSearchParams()[0].get("view") === "archived";
  const active = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);
  const shown = archivedView ? archived : active;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
      });
      await refresh();
      setOpen(false);
      navigate(`/projects/${project.slug}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>
            {archivedView ? "Archived projects" : "Projects"}{" "}
            <span className="count">{shown.length}</span>
          </h1>
          <p className="muted">
            {archivedView
              ? "Read-only projects kept for reference. Restore one to work in it again."
              : "Big ideas, organized into the next small steps."}
          </p>
        </div>
        <Button
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          <Plus size={16} />
          Create project
        </Button>
      </header>
      {(archived.length > 0 || archivedView) && (
        <div className="filter-bar">
          <nav className="view-toggle" aria-label="Project status">
            <Link
              className={!archivedView ? "active" : ""}
              aria-current={!archivedView ? "page" : undefined}
              to="/projects"
            >
              <FolderKanban size={15} />
              Active <span className="toggle-count">{active.length}</span>
            </Link>
            <Link
              className={archivedView ? "active" : ""}
              aria-current={archivedView ? "page" : undefined}
              to="/projects?view=archived"
            >
              <Archive size={15} />
              Archived <span className="toggle-count">{archived.length}</span>
            </Link>
          </nav>
        </div>
      )}
      {shown.length ? (
        <div className="project-grid">
          {shown.map((p, i) => (
            <div className="project-card-wrapper" key={p.id}>
            <Link
              to={`/projects/${p.slug}`}
              className={`project-card${p.archivedAt ? " is-archived" : ""}`}
            >
              <div className="card-top">
                <span className={`project-icon tone-${i % 3}`}>
                  {p.archivedAt ? (
                    <Archive size={21} />
                  ) : (
                    <FolderKanban size={21} />
                  )}
                </span>
                {p.archivedAt ? (
                  <span className="tag">Archived</span>
                ) : (
                  <ArrowUpRight size={18} className="muted" />
                )}
              </div>
              <h2>{p.name}</h2>
              <p>
                {p.description || "A fresh space for your team’s next idea."}
              </p>
              <footer>
                <span>
                  {p.archivedAt
                    ? `Archived ${new Date(p.archivedAt).toLocaleDateString()}`
                    : `${p.openCount} unfinished on board`}
                </span>
                <span>{p.issueCount} total</span>
              </footer>
            </Link>
            <FavoriteProjectButton project={p} />
            </div>
          ))}
        </div>
      ) : archivedView ? (
        <section className="empty-state compact">
          <Archive size={32} />
          <h2>No archived projects</h2>
          <p>Archive a finished project from its page to tuck it away.</p>
        </section>
      ) : (
        <section className="empty-state">
          <div className="empty-icon">
            <FolderKanban size={30} />
          </div>
          <h2>
            {archived.length
              ? "Every project is archived."
              : "A little structure. A lot of possibility."}
          </h2>
          <p>
            {archived.length ? (
              "Start something new, or restore a project from Archived."
            ) : (
              <>
                Create your first project to give your ideas a home.
                <br />
                Then turn them into issues your team can move forward.
              </>
            )}
          </p>
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} />
            {archived.length ? "Create project" : "Create your first project"}
          </Button>
        </section>
      )}
      <Modal
        title="Create project"
        description="Give your team’s next chapter a home."
        open={open}
        onOpenChange={(v) => !busy && setOpen(v)}
      >
        <form className="form-stack" onSubmit={create}>
          <label>
            Project name
            <input
              name="name"
              placeholder="e.g. Website redesign"
              required
              maxLength={100}
            />
          </label>
          <label>
            Description
            <textarea
              name="description"
              placeholder="What are we building?"
              rows={3}
              maxLength={10000}
            />
          </label>
          <ErrorNotice error={error} />
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
