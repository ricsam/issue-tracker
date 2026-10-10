import { useState } from "react";
import { emptyBoardFilters, type BoardFilterState } from "./board-filters";

export interface BoardPreferences {
  filters: BoardFilterState;
  search: string;
  filtersExpanded: boolean;
  collapsedLanes: string[];
}
export function defaultBoardPreferences(): BoardPreferences {
  return { filters: { ...emptyBoardFilters, tags: [], users: [] }, search: "", filtersExpanded: true, collapsedLanes: [] };
}
export function boardPreferencesKey(userId: string, boardId: string) {
  return `threadline:board-preferences:v1:${encodeURIComponent(userId)}:${encodeURIComponent(boardId)}`;
}
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
export function parseBoardPreferences(raw: string | null): BoardPreferences {
  const fallback = defaultBoardPreferences();
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const filters = value.filters ?? {};
    return {
      filters: {
        state: ["all", "open", "closed"].includes(filters.state) ? filters.state : "all",
        lane: typeof filters.lane === "string" ? filters.lane : "",
        tags: strings(filters.tags), users: strings(filters.users),
        creator: typeof filters.creator === "string" ? filters.creator : "",
      },
      search: typeof value.search === "string" ? value.search : "",
      filtersExpanded: typeof value.filtersExpanded === "boolean" ? value.filtersExpanded : true,
      collapsedLanes: strings(value.collapsedLanes),
    };
  } catch { return fallback; }
}
function load(key: string | null) {
  try { return parseBoardPreferences(key ? localStorage.getItem(key) : null); }
  catch { return defaultBoardPreferences(); }
}
/** Scope changes load synchronously: never write the previous user's preferences to a new key. */
export function useBoardPreferences(userId: string, boardId?: string) {
  const key = boardId ? boardPreferencesKey(userId, boardId) : null;
  const [stored, setStored] = useState(() => ({ key, value: load(key) }));
  const value = stored.key === key ? stored.value : load(key);
  if (stored.key !== key) setStored({ key, value });
  function update(patch: Partial<BoardPreferences>) {
    setStored((current) => {
      const next = { ...(current.key === key ? current.value : load(key)), ...patch };
      try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* Privacy/quota restrictions must not break controls. */ }
      return { key, value: next };
    });
  }
  return [value, update] as const;
}
