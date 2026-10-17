import { createContext, useContext, useEffect } from "react";
import { hasPendingWorkspaceWrites } from "./api";
import type { Project, User, Workspace } from "../../shared/types";
import { canCreateIssues } from "../../shared/access";
export interface WorkspaceContextValue {
  user: User;
  users: User[];
  projects: Project[];
  workspace: Workspace | null;
  workspaces: Workspace[];
  allowUserWorkspaceCreation: boolean;
  selectWorkspace: (slug: string) => void;
  refreshWorkspaces: () => Promise<void>;
  refresh: () => Promise<void>;
  updateProject: (project: Project) => void;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace unavailable");
  return value;
}
const dirtyEditors = new Set<symbol>();
export function useWorkspaceDraftGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const key = Symbol(); dirtyEditors.add(key);
    return () => { dirtyEditors.delete(key); };
  }, [dirty]);
}
export function confirmWorkspaceSwitch() {
  if (hasPendingWorkspaceWrites()) { window.alert("Please wait for the current save to finish before switching workspaces."); return false; }
  return !dirtyEditors.size || window.confirm("Discard unsaved changes and switch workspace?");
}
export const workspacePath = (slug: string, path = "/projects") => `/w/${encodeURIComponent(slug)}${path}`;
export const projectPath = (project: Pick<Project, "workspaceSlug" | "slug">) => workspacePath(project.workspaceSlug, `/projects/${encodeURIComponent(project.slug)}`);
export const issuePath = (issue: { workspaceSlug: string; number: number }) => workspacePath(issue.workspaceSlug, `/issues/${issue.number}`);
export const canEnterWorkspace = (workspace: Workspace) => workspace.role !== null || workspace.canManage;
export const canCreateProjectsInWorkspace = (workspace: Workspace | null) => !!workspace && (workspace.canManage || workspace.defaultAccess === "full");
export const canCreateInWorkspace = (workspace: Workspace | null) => !!workspace && (workspace.canManage || canCreateIssues(workspace.defaultAccess));
export function WorkspaceSelector({ onBeforeChange, disabled = false }: { onBeforeChange?: () => boolean; disabled?: boolean }) {
  const { workspace, workspaces, selectWorkspace } = useWorkspace();
  const accessible = workspaces.filter(canEnterWorkspace);
  return <label className="workspace-selector">Workspace
    <select aria-label="Workspace" value={workspace?.slug ?? ""} disabled={disabled || !accessible.length}
      onChange={(event) => { if (!onBeforeChange || onBeforeChange()) selectWorkspace(event.target.value); }}>
      {!workspace && <option value="">Select workspace</option>}
      {accessible.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
    </select>
  </label>;
}
