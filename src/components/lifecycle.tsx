import { useState } from "react";
import { Archive, ArchiveRestore, CircleCheck, CircleDot } from "lucide-react";
import type { IssueState, Project } from "../../shared/types";
import { api, message } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Button, ErrorNotice, Modal } from "./ui/primitives";

export function IssueStateBadge({ state }: { state: IssueState }) {
  return (
    <span className={`state-badge ${state}`}>
      {state === "closed" ? <CircleCheck size={14} /> : <CircleDot size={14} />}
      {state === "closed" ? "Closed" : "Open"}
    </span>
  );
}

/** Marks closed work wherever open and closed issues can appear together. */
export function ClosedTag() {
  return (
    <span className="tag closed-tag">
      <CircleCheck size={11} />
      Closed
    </span>
  );
}

function useArchiveRequest(
  project: Project,
  onChange: (project: Project) => void,
) {
  const { refresh } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function setArchived(archived: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ project: Project }>(
        `/api/projects/${encodeURIComponent(project.slug)}`,
        { method: "PATCH", body: JSON.stringify({ archived }) },
      );
      onChange(result.project);
      // Navigation reads workspace projects; the change itself already succeeded.
      void refresh().catch((e) => setError(message(e)));
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, setArchived };
}

export function ArchiveProjectButton({
  project,
  onChange,
}: {
  project: Project;
  onChange: (project: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const { busy, error, setError, setArchived } = useArchiveRequest(
    project,
    onChange,
  );
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Archive size={15} />
        Archive
      </Button>
      <Modal
        title="Archive project?"
        description={`${project.name} will be hidden from the sidebar and project list and become read-only. Its issues, comments and board are kept, and you can restore it at any time.`}
        open={open}
        onOpenChange={(value) => !busy && setOpen(value)}
      >
        <div className="form-stack">
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
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void setArchived(true).then((done) => done && setOpen(false))
              }
            >
              {busy ? "Archiving…" : "Archive project"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function ArchivedProjectNotice({
  project,
  onChange,
}: {
  project: Project;
  onChange: (project: Project) => void;
}) {
  const { users } = useWorkspace();
  const { busy, error, setArchived } = useArchiveRequest(project, onChange);
  const by = users.find((u) => u.id === project.archivedById)?.name;
  return (
    <>
      <section className="archived-notice" aria-label="Archived project">
        <Archive size={18} />
        <div>
          <strong>This project is archived.</strong>
          <p>
            Archived{" "}
            {project.archivedAt &&
              new Date(project.archivedAt).toLocaleDateString()}
            {by && ` by ${by}`}. It’s read-only and hidden from the sidebar.
            Restore it to create issues, edit, comment or change the board.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void setArchived(false)}
        >
          <ArchiveRestore size={15} />
          {busy ? "Restoring…" : "Restore project"}
        </Button>
      </section>
      <ErrorNotice error={error} />
    </>
  );
}
