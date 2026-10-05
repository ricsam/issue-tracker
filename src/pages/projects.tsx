import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, FolderKanban, Plus } from "lucide-react";
import type { Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "../components/ui/primitives";
export function ProjectsPage() {
  const { projects, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
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
            Projects <span className="count">{projects.length}</span>
          </h1>
          <p className="muted">
            Big ideas, organized into the next small steps.
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
      {projects.length ? (
        <div className="project-grid">
          {projects.map((p, i) => (
            <Link
              to={`/projects/${p.slug}`}
              className="project-card"
              key={p.id}
            >
              <div className="card-top">
                <span className={`project-icon tone-${i % 3}`}>
                  <FolderKanban size={21} />
                </span>
                <ArrowUpRight size={18} className="muted" />
              </div>
              <h2>{p.name}</h2>
              <p>
                {p.description || "A fresh space for your team’s next idea."}
              </p>
              <footer>
                <span>{p.openCount} unfinished on board</span>
                <span>{p.issueCount} total</span>
              </footer>
            </Link>
          ))}
        </div>
      ) : (
        <section className="empty-state">
          <div className="empty-icon">
            <FolderKanban size={30} />
          </div>
          <h2>A little structure. A lot of possibility.</h2>
          <p>
            Create your first project to give your ideas a home.
            <br />
            Then turn them into issues your team can move forward.
          </p>
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} />
            Create your first project
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
