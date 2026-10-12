import { useState } from "react";
import { boardFilterFields, emptyBoardFilters, type BoardFilterState } from "./board-filters";
import { normalizeIssueFilters, type IssueFilter } from "../lib/issue-filters";

export interface BoardPreferences {
  filters: BoardFilterState;
  search: string;
  filtersExpanded: boolean;
  collapsedLanes: string[];
}
export function defaultBoardPreferences(): BoardPreferences {
  return { filters: { ...emptyBoardFilters, conditions: [] }, search: "", filtersExpanded: true, collapsedLanes: [] };
}
export function boardPreferencesKey(userId: string, boardId: string) {
  return `threadline:board-preferences:v1:${encodeURIComponent(userId)}:${encodeURIComponent(boardId)}`;
}
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
/** Keep the v1 storage key and migrate each old selection to its own AND condition. */
function parseFilters(raw: unknown): BoardFilterState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...emptyBoardFilters, conditions: [] };
  if ("conditions" in raw || "conjunction" in raw) return normalizeIssueFilters(raw, boardFilterFields);
  const legacy = raw as Record<string, unknown>;
  const conditions: IssueFilter[] = [];
  function add(field: IssueFilter["field"], value: string) {
    if (value) conditions.push({ id: `legacy-${conditions.length + 1}`, field, operator: "is", value });
  }
  if (legacy.state === "open" || legacy.state === "closed") add("state", legacy.state);
  if (typeof legacy.lane === "string") add("lane", legacy.lane);
  strings(legacy.tags).filter(Boolean).forEach((tag) => add("labels", `label:${tag}`));
  strings(legacy.users).forEach((user) => add("tagged", user));
  if (typeof legacy.creator === "string" && legacy.creator) add("creator", `user:${legacy.creator}`);
  return normalizeIssueFilters({ conjunction: "and", conditions }, boardFilterFields);
}
export function parseBoardPreferences(raw: string | null): BoardPreferences {
  const fallback = defaultBoardPreferences();
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return fallback;
    return {
      filters: parseFilters(value.filters),
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
