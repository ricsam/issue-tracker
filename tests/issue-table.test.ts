import { expect, test } from "bun:test";
import type { Issue, Project, User } from "../shared/types";
import { hasColumnFilters, initialIssueTableState, issueDateKey, issueTableRows } from "../src/lib/issue-table";
import { boardLaneKey, boardLaneOptions, issueBoardLanes } from "../src/lib/issue-board-lanes";
import { defaultIssueColumns, issueColumnsStorageKey, moveIssueColumn, normalizeIssueColumns } from "../src/lib/issue-table-columns";

test("column preferences validate stored values, retain issue navigation and append new columns", () => {
  const defaults = defaultIssueColumns(false);
  expect(normalizeIssueColumns(null, false)).toEqual(defaults);
  expect(normalizeIssueColumns({ columns: [] }, false)).toEqual(defaults);
  const normalized = normalizeIssueColumns([
    { key: "created", visible: false }, { key: "title", visible: false },
    { key: "created", visible: true }, { key: "project", visible: false },
    { key: "unknown", visible: true }, null, "number", { key: "number" },
  ], false);
  expect(normalized.slice(0, 3)).toEqual([
    { key: "created", visible: false }, { key: "title", visible: true }, { key: "number", visible: true },
  ]);
  expect(new Set(normalized.map(({ key }) => key)).size).toBe(defaults.length);
  expect(normalized.some(({ key }) => key === "project")).toBe(false);
  expect(normalizeIssueColumns([], true)).toEqual(defaultIssueColumns(true));
});

test("column reordering is immutable, bounded and preserves visibility", () => {
  const columns = [{ key: "title" as const, visible: true }, { key: "number" as const, visible: false }];
  expect(moveIssueColumn(columns, "title", -1)).toBe(columns);
  expect(moveIssueColumn(columns, "number", 1)).toBe(columns);
  expect(moveIssueColumn(columns, "created", 1)).toBe(columns);
  const reordered = moveIssueColumn(columns, "number", -1);
  expect(reordered).toEqual([columns[1], columns[0]]);
  expect(columns[0].key).toBe("title");
  expect(moveIssueColumn(reordered, "number", 1)).toEqual(columns);
});

test("column preferences are scoped to user and list type", () => {
  expect(issueColumnsStorageKey("a", true)).not.toBe(issueColumnsStorageKey("a", false));
  expect(issueColumnsStorageKey("a", false)).not.toBe(issueColumnsStorageKey("b", false));
});

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
  const rows = [issue(1, { projectId: "p", labels: ["bug"] }), issue(2, { projectId: null, labels: ["bug"] }), issue(3, { projectId: "q" })];
  const ids = (state: Partial<typeof initialIssueTableState>) => issueTableRows(rows, users, { ...initialIssueTableState, ...state }, projects).map((row) => row.id);
  expect(ids({ project: "none" })).toEqual(["2"]);
  expect(ids({ project: "q" })).toEqual(["3"]);
  expect(ids({ project: "p", label: "label:bug" })).toEqual(["1"]);
  expect(ids({ project: "none", label: "label:other" })).toEqual([]);
  expect(ids({ sort: "project" })).toEqual(["1", "2", "3"]);
  expect(ids({ sort: "project", direction: "descending" })).toEqual(["3", "2", "1"]);
  expect(hasColumnFilters({ ...initialIssueTableState, project: "none" })).toBe(true);
  // Global numeric identifiers retain deterministic numeric order across projects.
  expect(issueTableRows([...rows].reverse(), users, initialIssueTableState)).toEqual(issueTableRows(rows, users, initialIssueTableState));
});

test("creator sorting uses displayed names, with numeric ties and an unknown-author fallback", () => {
  const rows = [issue(10, { authorId: "b" }), issue(3, { authorId: "missing" }), issue(2, { authorId: "a" }), issue(1, { authorId: "b" })];
  expect(numbers(issueTableRows(rows, users, { ...initialIssueTableState, sort: "creator" }))).toEqual([2, 1, 10, 3]);
  expect(numbers(issueTableRows(rows, users, { ...initialIssueTableState, sort: "creator", direction: "descending" }))).toEqual([3, 1, 10, 2]);
  expect(numbers(rows)).toEqual([10, 3, 2, 1]);
});

test("creator filters use identity rather than names or tagged users, combine with project and tags, and clear", () => {
  const sameNames = [...users, { ...users[0], id: "other", email: "other@example.test" }, { ...users[1], id: "unknown" }];
  const rows = [issue(1, { authorId: "a", taggedUserIds: ["b"], labels: ["bug"] }), issue(2, { authorId: "other", projectId: "q" }), issue(3, { authorId: "missing", projectId: null }), issue(4, { authorId: "unknown" }), issue(5, { authorId: "also-missing" })];
  const filtered = (state: Partial<typeof initialIssueTableState>) => numbers(issueTableRows(rows, sameNames, { ...initialIssueTableState, ...state }, projects));
  expect(filtered({ creator: "user:a", tagged: "b", label: "label:bug", project: "p" })).toEqual([1]);
  expect(filtered({ creator: "user:a", project: "q" })).toEqual([]);
  expect(filtered({ creator: "user:other" })).toEqual([2]);
  expect(filtered({ creator: "unknown" })).toEqual([3, 5]);
  expect(filtered({ creator: "user:unknown" })).toEqual([4]);
  expect(filtered({ creator: "" })).toEqual([1, 2, 3, 4, 5]);
  expect(hasColumnFilters({ ...initialIssueTableState, creator: "user:a" })).toBe(true);
  expect(hasColumnFilters({ ...initialIssueTableState, creator: "unknown" })).toBe(true);
  expect(hasColumnFilters(initialIssueTableState)).toBe(false);
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
  for (const number of ["10", "!10", " !10 "]) {
    expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, number }))).toEqual([10]);
  }
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, number: "!1", title: "ZEB", label: "label:bug", tagged: "a", createdFrom: day, createdTo: day }))).toEqual([10]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, createdFrom: "2026-01-03", createdTo: "2026-01-01" })).toEqual([]);
  expect(numbers(issueTableRows(issues, users, { ...initialIssueTableState, label: "label:design", tagged: "a" }))).toEqual([3]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, tagged: "none" })).toEqual([]);
  expect(issueTableRows(issues, users, { ...initialIssueTableState, label: "none" })).toEqual([]);
});
