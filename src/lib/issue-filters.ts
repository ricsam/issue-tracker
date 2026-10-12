import type { Issue, User } from "../../shared/types";

export const issueFilterFields = ["number", "title", "labels", "tagged", "creator", "created", "project", "lane", "state"] as const;
export type IssueFilterField = typeof issueFilterFields[number];
export interface IssueFilter {
  id: string;
  field: IssueFilterField;
  operator: "is" | "isNot";
  value: string;
  valueTo?: string;
}
export interface IssueFilterGroup {
  conjunction: "and" | "or";
  conditions: IssueFilter[];
}
export const emptyIssueFilters: IssueFilterGroup = { conjunction: "and", conditions: [] };

export function isActiveIssueFilter(filter: IssueFilter) {
  if (filter.field === "created") return !!(filter.value || filter.valueTo);
  if (filter.field === "number") return !!filter.value.trim().replace(/^!/, "");
  return !!filter.value.trim();
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
    const value = filter.value;
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
    return filter.operator === "isNot" ? !match : match;
  };
  return filters.conjunction === "or" ? conditions.some(matches) : conditions.every(matches);
}

function dateValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : "";
}

/** Validate browser storage, retaining unavailable options rather than silently changing their meaning. */
export function normalizeIssueFilters(raw: unknown, allowedFields: readonly IssueFilterField[] = issueFilterFields): IssueFilterGroup {
  if (!raw || typeof raw !== "object") return { ...emptyIssueFilters, conditions: [] };
  const group = raw as Partial<IssueFilterGroup>;
  const conditions: IssueFilter[] = [];
  const ids = new Set<string>();
  if (Array.isArray(group.conditions)) for (const item of group.conditions) {
    if (!item || typeof item !== "object" || !allowedFields.includes(item.field) || !["is", "isNot"].includes(item.operator) || typeof item.value !== "string") continue;
    if (item.field === "state" && !["", "open", "closed"].includes(item.value)) continue;
    if (item.field === "labels" && item.value && item.value !== "none" && !item.value.startsWith("label:")) continue;
    if (item.field === "creator" && item.value && item.value !== "unknown" && !item.value.startsWith("user:")) continue;
    let id = typeof item.id === "string" && item.id ? item.id : `filter-${conditions.length}`;
    while (ids.has(id)) id += "-duplicate";
    ids.add(id);
    conditions.push({ id, field: item.field, operator: item.operator,
      value: item.field === "created" ? dateValue(item.value) : item.value,
      ...(item.field === "created" ? { valueTo: dateValue(item.valueTo) } : {}),
    });
  }
  return { conjunction: group.conjunction === "or" ? "or" : "and", conditions };
}
