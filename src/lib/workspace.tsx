import { createContext, useContext } from "react";
import type { Project, User } from "../../shared/types";
export interface Workspace {
  user: User;
  users: User[];
  projects: Project[];
  refresh: () => Promise<void>;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace unavailable");
  return value;
}
