import { expect, test } from "bun:test";
import type { Issue, Project, User } from "../shared/types";
import { hasColumnFilters, initialIssueTableState, issueDateKey, issueTableRows } from "../src/lib/issue-table";

const users: User[] = [
  { id: "a", name: "Alex", email: "alex@example.test", role: "member", createdAt: "2026-01-01" },
  { id: "b", name: "Bea", email: "bea@example.test", role: "member", createdAt: "2026-01-01" },
];
const issue = (number: number, patch: Partial<Issue>): Issue => ({
  id: String(number), number, projectId: "p", title: `Issue ${number}`, body: "Body", labels: [], taggedUserIds: [], authorId: "a", state: "open", closedAt: null, closedById: null, createdAt: "2026-01-01T12:00:00Z", updatedAt: "2026-01-01T12:00:00Z", ...patch,
});
const issues = [
  issue(10, { title: "Zebra", labels: ["bug"], taggedUserIds: ["a"], createdAt: "2026-01-02T12:00:00Z" }),
  issue(2, { title: "Alpha", labels: ["design"], taggedUserIds: ["b"] }),
  issue(3, { title: "alpha", labels: ["bug", "design"], taggedUserIds: ["a", "b"] }),
];
const numbers = (rows: Issue[]) => rows.map((row) => row.number);

const projects: Project[] = [
  { id: "p", name: "Alpha", slug: "alpha", description: "", createdAt: "2026-01-01", archivedAt: null, archivedById: null, issueCount: 0, openCount: 0 },
  { id: "q", name: "Zebra", slug: "zebra", description: "", createdAt: "2026-01-01", archivedAt: "2026-01-02", archivedById: "a", issueCount: 0, openCount: 0 },
];

test("project filters distinguish unlinked and archived-project issues and combine with other filters", () => {
  const rows = [issue(1, { id: "linked", projectId: "p", labels: ["bug"] }), issue(1, { id: "unlinked", projectId: null, labels: ["bug"] }), issue(1, { id: "archived", projectId: "q" })];
  const ids = (state: Partial<typeof initialIssueTableState>) => issueTableRows(rows, users, { ...initialIssueTableState, ...state }, projects).map((row) => row.id);
  expect(ids({ project: "none" })).toEqual(["unlinked"]);
  expect(ids({ project: "q" })).toEqual(["archived"]);
  expect(ids({ project: "p", label: "label:bug" })).toEqual(["linked"]);
  expect(ids({ project: "none", label: "label:other" })).toEqual([]);
  expect(ids({ sort: "project" })).toEqual(["linked", "unlinked", "archived"]);
  expect(ids({ sort: "project", direction: "descending" })).toEqual(["archived", "unlinked", "linked"]);
  expect(hasColumnFilters({ ...initialIssueTableState, project: "none" })).toBe(true);
  // Duplicate per-project issue numbers still have a deterministic row order.
  expect(issueTableRows([...rows].reverse(), users, initialIssueTableState)).toEqual(issueTableRows(rows, users, initialIssueTableState));
});

test("table sorts without mutation and breaks ties by number", () => {
  expect(numbers(issueTableRows(issues, users, initialIssueTableState))).toEqual([2, 3, 10]);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, sort: "title", direction: "descending" }))).toEqual([10, 2, 3]);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, sort: "created", direction: "descending" }))).toEqual([10, 2, 3]);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, sort: "tagged" }))).toEqual([10, 3, 2]);
  expect(numbers(issues)).toEqual([10, 2, 3]);
  expect(issues[2].labels).toEqual(["bug", "design"]);
});

test("table combines filters and includes both calendar date boundaries", () => {
  const day = issueDateKey(issues[0].createdAt);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, number: "#1", title: "ZEB", label: "label:bug", tagged: "a", createdFrom: day, createdTo: day }))).toEqual([10]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, createdFrom: "2026-01-03", createdTo: "2026-01-01" })).toEqual([]);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, label: "label:design", tagged: "a" }))).toEqual([3]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, tagged: "none" })).toEqual([]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, label: "none" })).toEqual([]);
});
