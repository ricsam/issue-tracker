import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "./workspace";
import { api, message } from "./api";
import { useNotification } from "../components/ui/snackbar";

type PinnedProjects = {
  projectIds: string[];
  loading: boolean;
  busy: boolean;
  error: string;
  retry: () => void;
  /** Each write resolves true when the server confirmed it. */
  toggle: (projectId: string) => Promise<boolean>;
  pin: (projectId: string, beforeProjectId?: string | null) => Promise<boolean>;
  unpin: (projectId: string) => Promise<boolean>;
};
const PinnedProjectsContext = createContext<PinnedProjects | null>(null);

/** Mounted per signed-in user, independent of shared project refreshes. */
export function PinnedProjectsProvider({ children }: { children: ReactNode }) {
  const { workspace } = useWorkspace();
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const notify = useNotification();
  useEffect(() => {
    if (!workspace) { setProjectIds([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ projectIds: string[] }>("/api/me/pinned-projects", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setProjectIds(result.projectIds); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, workspace?.slug]);
  const update = useCallback(async (projectId: string, removing: boolean, beforeProjectId?: string | null) => {
    if (pending.current || loading || error) return false;
    pending.current = true;
    setBusy(true);
    try {
      const result = await api<{ projectIds: string[] }>(`/api/me/pinned-projects/${encodeURIComponent(projectId)}`, {
        method: removing ? "DELETE" : "PUT",
        body: !removing && beforeProjectId !== undefined ? JSON.stringify({ beforeProjectId }) : undefined,
      });
      // Apply only confirmed writes, so failed pin/reorder requests preserve the saved order.
      setProjectIds(result.projectIds);
      notify(removing ? "Project unpinned" : projectIds.includes(projectId) ? "Pinned projects reordered" : "Project pinned");
      return true;
    } catch (cause) {
      notify(`Could not update pinned projects: ${message(cause)}`, "error");
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [projectIds, loading, error, notify]);
  return <PinnedProjectsContext.Provider value={{
    projectIds, loading, busy, error, retry: () => setAttempt((value) => value + 1),
    toggle: (id) => update(id, projectIds.includes(id)),
    pin: (id, before) => update(id, false, before),
    unpin: (id) => update(id, true),
  }}>{children}</PinnedProjectsContext.Provider>;
}
export function usePinnedProjects() {
  const value = useContext(PinnedProjectsContext);
  if (!value) throw new Error("Pinned projects unavailable");
  return value;
}
