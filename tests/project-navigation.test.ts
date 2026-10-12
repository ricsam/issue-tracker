import { expect, test } from "bun:test";
import type { Project } from "../shared/types";
import { projectNavigation } from "../src/lib/project-navigation";

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id, name: id, slug: id, description: "", visibility: "public", ownerId: "user", sharedUserIds: [],
  createdAt: "2026-01-01T00:00:00.000Z", lastIssueUpdatedAt: null,
  archivedAt: null, archivedById: null, issueCount: 0, openCount: 0, ...overrides,
});
const ids = (items: Project[]) => items.map((item) => item.id);

test("pins use saved order, ignoring unavailable/archived projects, while unpinned projects follow issue recency", () => {
  const projects = [project("alpha"), project("beta"), project("archived", { archivedAt: "2026-01-02" }),
    project("older", { lastIssueUpdatedAt: "2026-01-02T00:00:00.000Z" }),
    project("recent", { lastIssueUpdatedAt: "2026-01-04T00:00:00.000Z" }),
    project("empty", { createdAt: "2026-01-03T00:00:00.000Z" })];
  const before = [...projects];
  const { pinned, others } = projectNavigation(projects, ["beta", "missing", "archived", "alpha"]);
  expect(ids(pinned)).toEqual(["beta", "alpha"]);
  expect(ids(others)).toEqual(["recent", "empty", "older"]);
  expect(projects).toEqual(before);
});

test("activity changes cannot disturb pin order and unpinning restores recency placement", () => {
  const projects = [project("alpha", { lastIssueUpdatedAt: "2026-02-01" }), project("beta"), project("gamma", { lastIssueUpdatedAt: "2026-01-15" })];
  expect(ids(projectNavigation(projects, ["beta", "alpha"]).pinned)).toEqual(["beta", "alpha"]);
  expect(ids(projectNavigation(projects, ["beta"]).others)).toEqual(["alpha", "gamma"]);
});

test("equal timestamps use deterministic name and id tie-breaks and do not mutate input", () => {
  const projects = [project("z"), project("a2", { name: "a" }), project("a1", { name: "a" })];
  expect(ids(projectNavigation(projects, []).others)).toEqual(["a1", "a2", "z"]);
  expect(ids(projects)).toEqual(["z", "a2", "a1"]);
});
