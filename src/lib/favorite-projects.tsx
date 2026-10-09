import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, message } from "./api";
import { useNotification } from "../components/ui/snackbar";

type Favorites = {
  projectIds: string[];
  loading: boolean;
  busy: boolean;
  error: string;
  retry: () => void;
  toggle: (projectId: string) => Promise<void>;
};
const FavoritesContext = createContext<Favorites | null>(null);

/** Mounted per signed-in user, independent of shared project refreshes. */
export function FavoriteProjectsProvider({ children }: { children: ReactNode }) {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const notify = useNotification();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ projectIds: string[] }>("/api/me/favorite-projects", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setProjectIds(result.projectIds); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const toggle = useCallback(async (projectId: string) => {
    if (pending.current || loading || error) return;
    pending.current = true;
    setBusy(true);
    const removing = projectIds.includes(projectId);
    try {
      const result = await api<{ projectIds: string[] }>(`/api/me/favorite-projects/${projectId}`, { method: removing ? "DELETE" : "PUT" });
      setProjectIds(result.projectIds);
      notify(removing ? "Project removed from favorites" : "Project added to favorites");
    } catch (cause) {
      notify(`Could not update favorites: ${message(cause)}`, "error");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [projectIds, loading, error, notify]);
  return <FavoritesContext.Provider value={{ projectIds, loading, busy, error, retry: () => setAttempt((value) => value + 1), toggle }}>{children}</FavoritesContext.Provider>;
}
export function useFavoriteProjects() {
  const value = useContext(FavoritesContext);
  if (!value) throw new Error("Favorites unavailable");
  return value;
}
