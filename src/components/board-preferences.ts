import { useState } from "react";
import { boardFilterFields, type BoardFilterState } from "./board-filters";
import { defaultIssueFilters, filterPreferencesVersion, normalizeIssueFilters, withDefaultStateFilter, type IssueFilter } from "../lib/issue-filters";

export interface BoardPreferences {
  filters: BoardFilterState;
  search: string;
  collapsedLanes: string[];
  hiddenLanes: string[];
}
export function defaultBoardPreferences(): BoardPreferences {
  return { filters: structuredClone(defaultIssueFilters), search: "", collapsedLanes: [], hiddenLanes: [] };
}
export function boardPreferencesKey(userId: string, boardId: string) {
  return `threadline:board-preferences:v1:${encodeURIComponent(userId)}:${encodeURIComponent(boardId)}`;
}
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
/** Keep the v1 storage key and migrate each old selection to its own AND condition. */
function parseFilters(raw: unknown): BoardFilterState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return structuredClone(defaultIssueFilters);
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
    const filters = parseFilters(value.filters);
    return {
      // Older boards defaulted to all states; add the visible open default where it only narrows.
      filters: value.version === filterPreferencesVersion ? filters : withDefaultStateFilter(filters),
      search: typeof value.search === "string" ? value.search : "",
      collapsedLanes: strings(value.collapsedLanes),
      hiddenLanes: strings(value.hiddenLanes),
    };
  } catch { return fallback; }
}
export function serializeBoardPreferences(preferences: BoardPreferences, filtersOverridden = true) {
  return JSON.stringify({ ...preferences, version: filterPreferencesVersion, filtersOverridden });
}
/** An explicit empty group is still an override. Appearance/search writes are not. */
export function hasBoardFilterOverride(raw: string | null): boolean {
  try {
    const value = JSON.parse(raw ?? "null");
    return !!value && typeof value === "object" && !Array.isArray(value)
      && value.filtersOverridden !== false && !!value.filters && typeof value.filters === "object" && !Array.isArray(value.filters);
  } catch { return false; }
}
export function resolveBoardFilters(raw: string | null, defaults?: BoardFilterState | null): BoardFilterState {
  return hasBoardFilterOverride(raw) ? parseBoardPreferences(raw).filters : structuredClone(defaults ?? defaultIssueFilters);
}
function load(key: string | null) {
  let raw: string | null = null;
  try { raw = key ? localStorage.getItem(key) : null; } catch { /* Storage can be blocked. */ }
  return { preferences: parseBoardPreferences(raw), filtersOverridden: hasBoardFilterOverride(raw) };
}
/** Scope changes load synchronously: never write the previous user's preferences to a new key. */
export function useBoardPreferences(userId: string, boardId?: string, defaults?: BoardFilterState | null) {
  const key = boardId ? boardPreferencesKey(userId, boardId) : null;
  const [stored, setStored] = useState(() => ({ key, ...load(key) }));
  const current = stored.key === key ? stored : { key, ...load(key) };
  if (stored.key !== key) setStored(current);
  const value = { ...current.preferences, filters: current.filtersOverridden ? current.preferences.filters : defaults ?? defaultIssueFilters };
  function persist(patch: Partial<BoardPreferences>, reset = false) {
    setStored((previous) => {
      const base = previous.key === key ? previous : { key, ...load(key) };
      const filtersOverridden = reset ? false : patch.filters !== undefined || base.filtersOverridden;
      const preferences = { ...base.preferences, ...patch };
      try { if (key) localStorage.setItem(key, serializeBoardPreferences(preferences, filtersOverridden)); } catch { /* Privacy/quota restrictions must not break controls. */ }
      return { key, preferences, filtersOverridden };
    });
  }
  return [value, (patch: Partial<BoardPreferences>) => persist(patch), {
    filtersOverridden: current.filtersOverridden,
    resetFilters: () => persist({}, true),
  }] as const;
}
