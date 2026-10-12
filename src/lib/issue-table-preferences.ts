import { useState } from "react";
import { initialIssueTableState, type IssueTableState } from "./issue-table";
import { issueFilterFields, normalizeIssueFilters } from "./issue-filters";

export function issueTablePreferencesKey(userId: string, scope: string) {
  return `threadline:issue-table:v1:${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`;
}
export function parseIssueTablePreferences(raw: string | null, includeProject = true): IssueTableState {
  try {
    const value = JSON.parse(raw ?? "null");
    const fields = issueFilterFields.filter((field) => field !== "state" && (includeProject || field !== "project"));
    return {
      sort: fields.includes(value?.sort) ? value.sort : initialIssueTableState.sort,
      direction: value?.direction === "descending" ? "descending" : "ascending",
      filters: normalizeIssueFilters(value?.filters, fields),
    };
  } catch { return { ...initialIssueTableState, filters: { conjunction: "and", conditions: [] } }; }
}
function load(key: string | null, includeProject: boolean) {
  try { return parseIssueTablePreferences(key ? localStorage.getItem(key) : null, includeProject); }
  catch { return parseIssueTablePreferences(null, includeProject); }
}
/** A synchronous scope switch avoids showing or storing a different account/project's filters. */
export function useIssueTablePreferences(userId: string, scope: string | null) {
  const key = scope ? issueTablePreferencesKey(userId, scope) : null;
  const includeProject = scope === "all";
  const [stored, setStored] = useState(() => ({ key, value: load(key, includeProject) }));
  const value = stored.key === key ? stored.value : load(key, includeProject);
  if (stored.key !== key) setStored({ key, value });
  function update(next: IssueTableState) {
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep filters usable when storage is blocked or full. */ }
    setStored({ key, value: next });
  }
  return [value, update] as const;
}
