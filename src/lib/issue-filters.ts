import type { Issue, User } from "../../shared/types";

export const issueFilterFields = ["number", "title", "labels", "tagged", "creator", "created", "project", "lane", "state"] as const;
export type IssueFilterField = typeof issueFilterFields[number];
export interface IssueFilter {
  id: string;
  field: IssueFilterField;
  operator: "is" | "isNot" | "isOneOf" | "matchesEvery";
  value: string;
  values?: string[];
  valueTo?: string;
}
export interface IssueFilterGroup {
  conjunction: "and" | "or";
  conditions: IssueFilter[];
}
export const emptyIssueFilters: IssueFilterGroup = { conjunction: "and", conditions: [] };
export const defaultIssueFilters: IssueFilterGroup = {
  conjunction: "and",
  conditions: [{ id: "default-state", field: "state", operator: "is", value: "open" }],
};
/** Saved filter preferences without this version predate the visible State chip. */
export const filterPreferencesVersion = 2;

const optionFields: readonly IssueFilterField[] = ["labels", "tagged", "creator", "project", "lane", "state"];
const isMultiValue = (filter: IssueFilter) => filter.operator === "isOneOf" || filter.operator === "matchesEvery";
// An explicit empty selection overrides the scalar fallback used by older callers.
const selectedValues = (filter: IssueFilter) => (filter.values ?? [filter.value]).filter((value) => value.trim());

export function isActiveIssueFilter(filter: IssueFilter) {
  if (isMultiValue(filter)) return selectedValues(filter).length > 0;
  if (filter.field === "created") return !!(filter.value || filter.valueTo);
  if (filter.field === "number") return !!filter.value.trim().replace(/^!/, "");
  return !!filter.value.trim();
}

/**
 * Add the default open-state chip to filters saved before it existed. Existing
 * State choices are kept, and an OR group is left unchanged because adding a
 * chip there would widen rather than narrow its results.
 */
export function withDefaultStateFilter(group: IssueFilterGroup): IssueFilterGroup {
  if (group.conditions.some((filter) => filter.field === "state")) return group;
  if (group.conjunction === "or" && group.conditions.some(isActiveIssueFilter)) return group;
  let id = defaultIssueFilters.conditions[0].id;
  while (group.conditions.some((filter) => filter.id === id)) id += "-migrated";
  return { ...group, conditions: [{ ...defaultIssueFilters.conditions[0], id }, ...group.conditions] };
}

/** The local calendar date used by both filtering and the displayed table date. */
export function issueDateKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function matchesIssueFilters(issue: Issue, filters: IssueFilterGroup, context: { users: readonly User[]; lane?: string }) {
  const conditions = filters.conditions.filter(isActiveIssueFilter);
  // Blank draft rows never widen an OR expression or narrow an AND expression.
  if (!conditions.length) return true;
  const matches = (filter: IssueFilter) => {
    const matchesValue = (value: string) => {
      let match: boolean;
      switch (filter.field) {
        case "number": match = String(issue.number).includes(value.trim().replace(/^!/, "")); break;
        case "title": match = issue.title.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()); break;
        case "labels": match = value === "none" ? issue.labels.length === 0 : issue.labels.includes(value.slice(6)); break;
        case "tagged": match = value === "none" ? issue.taggedUserIds.length === 0 : issue.taggedUserIds.includes(value); break;
        case "creator": match = value === "unknown" ? !context.users.some((user) => user.id === issue.authorId) : issue.authorId === value.slice(5); break;
        case "project": match = value === "none" ? issue.projectId === null : issue.projectId === value; break;
        case "lane": match = value === "none" ? context.lane === undefined : context.lane === value; break;
        case "state": match = issue.state === value; break;
        case "created": {
          const date = issueDateKey(issue.createdAt);
          match = (!value || date >= value) && (!filter.valueTo || date <= filter.valueTo);
          break;
        }
      }
      return match;
    };
    if (filter.operator === "isOneOf") return selectedValues(filter).some(matchesValue);
    if (filter.operator === "matchesEvery") return selectedValues(filter).every(matchesValue);
    const match = matchesValue(filter.value);
    return filter.operator === "isNot" ? !match : match;
  };
  return filters.conjunction === "or" ? conditions.some(matches) : conditions.every(matches);
}

function dateValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : "";
}

function validOptionValue(field: IssueFilterField, value: string): boolean {
  if (!value.trim()) return true;
  if (field === "state") return value === "open" || value === "closed" || value === "draft";
  if (field === "labels") return value === "none" || (value.startsWith("label:") && !!value.slice(6).trim());
  if (field === "creator") return value === "unknown" || (value.startsWith("user:") && !!value.slice(5).trim());
  return true;
}

/** Validate browser storage, retaining unavailable options rather than silently changing their meaning. */
export function normalizeIssueFilters(raw: unknown, allowedFields: readonly IssueFilterField[] = issueFilterFields): IssueFilterGroup {
  if (!raw || typeof raw !== "object") return { ...emptyIssueFilters, conditions: [] };
  const group = raw as Partial<IssueFilterGroup>;
  const conditions: IssueFilter[] = [];
  const ids = new Set<string>();
  if (Array.isArray(group.conditions)) for (const item of group.conditions) {
    if (!item || typeof item !== "object" || !issueFilterFields.includes(item.field) || !allowedFields.includes(item.field) || !["is", "isNot", "isOneOf", "matchesEvery"].includes(item.operator) || typeof item.value !== "string") continue;
    if (item.operator === "isOneOf" && !optionFields.includes(item.field)) continue;
    if (item.operator === "matchesEvery" && item.field !== "labels" && item.field !== "tagged") continue;
    if (!validOptionValue(item.field, item.value)) continue;
    if (item.values !== undefined && (!Array.isArray(item.values) || !item.values.every((value: unknown) => typeof value === "string" && validOptionValue(item.field, value)))) continue;
    let id = typeof item.id === "string" && item.id ? item.id : `filter-${conditions.length}`;
    while (ids.has(id)) id += "-duplicate";
    ids.add(id);
    conditions.push({ id, field: item.field, operator: item.operator,
      value: item.field === "created" ? dateValue(item.value) : item.value,
      ...(item.field === "created" ? { valueTo: dateValue(item.valueTo) } : {}),
      ...(isMultiValue(item) && item.values !== undefined ? { values: [...new Set(item.values.filter((value: string) => value.trim()))] } : {}),
    });
  }
  return { conjunction: group.conjunction === "or" ? "or" : "and", conditions };
}
