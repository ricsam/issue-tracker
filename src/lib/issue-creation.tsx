import { createContext, lazy, Suspense, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { BoardSettings, Issue } from "../../shared/types";
import { message } from "./api";
import { useNewIssueShortcut } from "./issue-shortcuts";
import { useWorkspace } from "./workspace";
import { ErrorNotice } from "../components/ui/primitives";

const CreateIssueDialog = lazy(() => import("../components/create-issue-dialog").then((module) => ({ default: module.CreateIssueDialog })));
const IssueCreationContext = createContext<{
  open: () => void;
  register: (handler: () => void) => () => void;
  createdIssues: Issue[];
  createdBoards: Record<string, BoardSettings>;
} | null>(null);

/** One shortcut owner, with page handlers preserving local drafts and detail panels. */
export function IssueCreationProvider({ children }: { children: ReactNode }) {
  const handler = useRef<(() => void) | null>(null);
  const [creating, setCreating] = useState(false);
  // A shortcut can open the global dialog while a route is still loading.
  // Retain those results so the eventual list cannot miss or overwrite them.
  const [createdIssues, setCreatedIssues] = useState<Issue[]>([]);
  const [createdBoards, setCreatedBoards] = useState<Record<string, BoardSettings>>({});
  const [error, setError] = useState("");
  const { refresh } = useWorkspace();
  const navigate = useNavigate();
  const register = useCallback((next: () => void) => {
    handler.current = next;
    return () => { if (handler.current === next) handler.current = null; };
  }, []);
  const open = useCallback(() => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    if (handler.current) handler.current();
    else setCreating(true);
  }, []);
  useNewIssueShortcut(open, true);
  return <IssueCreationContext.Provider value={{ open, register, createdIssues, createdBoards }}>
    {children}
    <ErrorNotice error={error} />
    {creating && <Suspense fallback={null}><CreateIssueDialog
      onCreated={(issue) => {
        setCreatedIssues((current) => [...current, issue]);
        void refresh().catch((cause) => setError(`Issue created, but workspace counts could not refresh: ${message(cause)}`));
      }}
      onBoardChanged={(projectId, board) => setCreatedBoards((current) => ({ ...current, [projectId]: board }))}
      onClose={() => setCreating(false)}
      canViewIssue={() => true}
      onViewIssue={(issue) => { setCreating(false); navigate(`/issues/${issue.id}`); }}
    /></Suspense>}
  </IssueCreationContext.Provider>;
}

export function useIssueCreation() {
  const context = useContext(IssueCreationContext);
  if (!context) throw new Error("Missing issue creation provider");
  return context.open;
}

export function useGloballyCreatedIssues() {
  return useContext(IssueCreationContext)!.createdIssues;
}

export function useGloballyCreatedBoards() {
  return useContext(IssueCreationContext)!.createdBoards;
}

export function useIssueCreationHandler(handler: () => void, enabled = true) {
  const context = useContext(IssueCreationContext);
  const register = context?.register;
  useLayoutEffect(() => enabled ? register?.(handler) : undefined, [register, handler, enabled]);
}
