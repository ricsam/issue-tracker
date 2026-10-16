import { useState } from "react";
import { initialIssueTableState, type IssueTableState } from "./issue-table";
import { filterPreferencesVersion, issueFilterFields, normalizeIssueFilters, withDefaultStateFilter } from "./issue-filters";

export function issueTablePreferencesKey(userId: string, scope: string) {
  return `threadline:issue-table:v1:${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`;
}
export function parseIssueTablePreferences(raw: string | null, includeProject = true): IssueTableState {
  try {
    const value = JSON.parse(raw ?? "null");
    const fields = issueFilterFields.filter((field) => includeProject || field !== "project");
    const saved = !!value?.filters && typeof value.filters === "object" && !Array.isArray(value.filters);
    const filters = saved ? normalizeIssueFilters(value.filters, fields) : structuredClone(initialIssueTableState.filters);
    return {
      sort: fields.includes(value?.sort) ? value.sort : initialIssueTableState.sort,
      direction: value?.direction === "descending" ? "descending" : "ascending",
      // Older lists applied their Open/Closed view outside the saved conditions.
      filters: saved && value.version !== filterPreferencesVersion ? withDefaultStateFilter(filters) : filters,
    };
  } catch { return { ...initialIssueTableState, filters: structuredClone(initialIssueTableState.filters) }; }
}
export function serializeIssueTablePreferences(state: IssueTableState) {
  return JSON.stringify({ ...state, version: filterPreferencesVersion });
}
function load(key: string | null, includeProject: boolean) {
  try { return parseIssueTablePreferences(key ? localStorage.getItem(key) : null, includeProject); }
  catch { return parseIssueTablePreferences(null, includeProject); }
}
/** A synchronous scope switch avoids showing or storing a different account/project's filters. */
export function useIssueTablePreferences(userId: string, scope: string | null) {
  const key = scope ? issueTablePreferencesKey(userId, scope) : null;
  const includeProject = scope === "all" || scope?.startsWith("workspace:") === true;
  const [stored, setStored] = useState(() => ({ key, value: load(key, includeProject) }));
  const value = stored.key === key ? stored.value : load(key, includeProject);
  if (stored.key !== key) setStored({ key, value });
  function update(next: IssueTableState) {
    try { if (key) localStorage.setItem(key, serializeIssueTablePreferences(next)); } catch { /* Keep filters usable when storage is blocked or full. */ }
    setStored({ key, value: next });
  }
  return [value, update] as const;
}
