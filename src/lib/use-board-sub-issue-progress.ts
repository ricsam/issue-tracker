import { useCallback, useEffect, useRef, useState } from "react";
import type { SubIssueProgress } from "../../shared/types";
import { api, message } from "./api";

/** Refresh counts only, never replace the board, selection or an open editor draft. */
export function useBoardSubIssueProgress(slug: string, enabled: boolean, cardsKey: string, revision: number) {
  const [progress, setProgress] = useState<Record<string, SubIssueProgress>>({});
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ progress: Record<string, SubIssueProgress> }>(
        `/api/projects/${encodeURIComponent(slug)}/board/sub-issue-progress`, { signal: controller.signal },
      );
      if (!controller.signal.aborted) { setProgress(result.progress); setError(""); }
    } catch (cause) {
      // Unknown is not zero: hide stale counts after a failed access/network check.
      if (!controller.signal.aborted) { setProgress({}); setError(message(cause)); }
    }
  }, [slug, enabled]);
  useEffect(() => {
    if (!enabled) { setProgress({}); setError(""); return; }
    void load();
    return () => request.current?.abort();
  }, [enabled, load, cardsKey, revision]);
  useEffect(() => {
    if (!enabled) return;
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [enabled, load]);
  return { progress, error, retry: load };
}
