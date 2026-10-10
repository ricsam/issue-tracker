import type { BoardSettings, Project } from "../../shared/types";
import { orderedLanes } from "../../shared/board";

type Preferences = { projectId: string; lanes: Record<string, string> };
const key = (userId: string) => `issue-tracker:create-issue:${userId}`;

/** Storage is optional (private mode, quota limits, or corrupt older values). */
export function readCreationPreferences(userId: string): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (!value || typeof value !== "object") return { projectId: "", lanes: {} };
    const raw = value as Partial<Preferences>;
    return {
      projectId: typeof raw.projectId === "string" ? raw.projectId : "",
      lanes: raw.lanes && typeof raw.lanes === "object" && !Array.isArray(raw.lanes)
        ? Object.fromEntries(Object.entries(raw.lanes).filter(([, lane]) => typeof lane === "string")) : {},
    };
  } catch { return { projectId: "", lanes: {} }; }
}

export function rememberCreationSelection(userId: string, selection: { projectId?: string; lane?: { projectId: string; value: string } }) {
  const previous = readCreationPreferences(userId);
  try {
    localStorage.setItem(key(userId), JSON.stringify({
      projectId: selection.projectId ?? previous.projectId,
      lanes: selection.lane ? { ...previous.lanes, [selection.lane.projectId]: selection.lane.value } : previous.lanes,
    }));
  } catch { /* Creating an issue never depends on storage availability. */ }
}

export function creationProject(projects: Project[], remembered: string, context?: Project | null) {
  const id = context ? context.id : remembered;
  return projects.find((project) => project.id === id && !project.archivedAt)?.id ?? "";
}

export function creationLane(board: BoardSettings | undefined, remembered: string) {
  return board && orderedLanes(board.lanes, board.customLanes).some((lane) => lane.value === remembered) ? remembered : "";
}
