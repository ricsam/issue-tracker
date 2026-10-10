import type { IssueColumn } from "./issue-table";

export const issueTableColumns: { key: IssueColumn; label: string; width: number; className: string }[] = [
  { key: "number", label: "Number", width: 125, className: "number-column" },
  { key: "title", label: "Issue", width: 280, className: "title-column" },
  { key: "project", label: "Project", width: 180, className: "project-column" },
  { key: "lane", label: "Board lane", width: 175, className: "lane-column" },
  { key: "labels", label: "Tags", width: 145, className: "labels-column" },
  { key: "tagged", label: "Tagged users", width: 180, className: "users-column" },
  { key: "creator", label: "Creator", width: 160, className: "creator-column" },
  { key: "created", label: "Created", width: 190, className: "date-column" },
];

export interface IssueColumnPreference { key: IssueColumn; visible: boolean }

export function defaultIssueColumns(includeProject: boolean): IssueColumnPreference[] {
  return issueTableColumns.filter(({ key }) => includeProject || key !== "project").map(({ key }) => ({ key, visible: true }));
}

/** Ignore stale/invalid settings and append newly introduced columns. Keep an issue link available. */
export function normalizeIssueColumns(value: unknown, includeProject: boolean): IssueColumnPreference[] {
  const defaults = defaultIssueColumns(includeProject);
  if (!Array.isArray(value)) return defaults;
  const result: IssueColumnPreference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !defaults.some(({ key }) => key === item.key) || result.some(({ key }) => key === item.key)) continue;
    result.push({ key: item.key, visible: item.key === "title" || item.visible !== false });
  }
  return [...result, ...defaults.filter(({ key }) => !result.some((item) => item.key === key))];
}

export function moveIssueColumn(columns: IssueColumnPreference[], key: IssueColumn, direction: -1 | 1): IssueColumnPreference[] {
  const from = columns.findIndex((column) => column.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= columns.length) return columns;
  const next = [...columns];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function issueColumnsStorageKey(userId: string, includeProject: boolean) {
  return `threadline:issue-columns:v1:${encodeURIComponent(userId)}:${includeProject ? "all" : "project"}`;
}
