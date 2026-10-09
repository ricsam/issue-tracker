import { expect, test } from "bun:test";
import type { Issue, Project, User } from "../shared/types";
import { hasColumnFilters, initialIssueTableState, issueDateKey, issueTableRows } from "../src/lib/issue-table";
import { boardLaneKey, boardLaneOptions, issueBoardLanes } from "../src/lib/issue-board-lanes";

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

test("board lane display, filter and sort reflect membership including hidden custom lanes and project identity", () => {
  const boards = {
    p: { lanes: ["todo", "done"], customLanes: [{ value: "review", label: "Review" }], cards: [{ issueId: "1", lane: "todo" }, { issueId: "2", lane: "review" }] },
    q: { lanes: ["todo"], customLanes: [{ value: "review", label: "Review" }], cards: [{ issueId: "3", lane: "todo" }, { issueId: "4", lane: "review" }] },
  };
  const lanes = issueBoardLanes(boards);
  expect(lanes.get("2")).toEqual({ value: boardLaneKey("p", "review"), label: "Review", hidden: true });
  const rows = [issue(1, {}), issue(2, { state: "closed", labels: ["bug"] }), issue(3, { projectId: "q" }), issue(4, { projectId: "q" }), issue(5, {}), issue(6, { projectId: null })];
  const filtered = (state: Partial<typeof initialIssueTableState>) => numbers(issueTableRows(rows, users, { ...initialIssueTableState, ...state }, projects, lanes));
  expect(filtered({ lane: boardLaneKey("p", "todo") })).toEqual([1]);
  expect(filtered({ lane: boardLaneKey("p", "review"), label: "label:bug" })).toEqual([2]);
  expect(filtered({ lane: boardLaneKey("p", "review"), project: "q" })).toEqual([]);
  expect(filtered({ lane: "none" })).toEqual([5, 6]);
  expect(filtered({ sort: "lane" })).toEqual([5, 6, 2, 4, 1, 3]);
  expect(filtered({ sort: "lane", direction: "descending" })).toEqual([1, 3, 2, 4, 5, 6]);
  expect(hasColumnFilters({ ...initialIssueTableState, lane: "none" })).toBe(true);
  expect(boardLaneOptions(boards, projects, true)).toContainEqual({ value: boardLaneKey("p", "review"), label: "Alpha · Review (hidden)" });
  expect(boardLaneOptions(boards, projects, true)).toContainEqual({ value: boardLaneKey("q", "review"), label: "Zebra · Review (hidden)" });
});

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
