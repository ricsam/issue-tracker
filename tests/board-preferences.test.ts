import { expect, test } from "bun:test";
import { boardPreferencesKey, defaultBoardPreferences, parseBoardPreferences, serializeBoardPreferences, type BoardPreferences } from "../src/components/board-preferences";

const openState = { id: "default-state", field: "state", operator: "is", value: "open" } as const;
const parseFilters = (filters: unknown) => parseBoardPreferences(JSON.stringify({ filters })).filters;
const parseSavedFilters = (filters: unknown) => parseBoardPreferences(JSON.stringify({ version: 2, filters })).filters;
test("board preferences preserve v1 key scoped to user and stable board ID", () => {
  expect(boardPreferencesKey("one", "board")).toBe("threadline:board-preferences:v1:one:board");
  expect(boardPreferencesKey("one", "board")).not.toBe(boardPreferencesKey("two", "board"));
  expect(boardPreferencesKey("one", "board")).not.toBe(boardPreferencesKey("one", "other"));
  expect(boardPreferencesKey("a:b", "c")).not.toBe(boardPreferencesKey("a", "b:c"));
});
test("malformed or missing preferences safely default", () => {
  for (const raw of [null, "broken", "null", "42", "[]"]) expect(parseBoardPreferences(raw)).toEqual(defaultBoardPreferences());
  expect(parseBoardPreferences(JSON.stringify({ filters: { state: "bad", tags: ["bug", 4, "bug"], users: false }, collapsedLanes: ["todo", null, "todo"], search: 42, filtersExpanded: "false" }))).toEqual({ ...defaultBoardPreferences(), filters: { conjunction: "and", conditions: [openState, { id: "legacy-1", field: "labels", operator: "is", value: "label:bug" }] }, collapsedLanes: ["todo"] });
  for (const filters of [null, [], 42]) expect(parseFilters(filters)).toEqual(defaultBoardPreferences().filters);
  expect(parseSavedFilters({ conjunction: "or", conditions: false }).conditions).toEqual([]);
});
test("new boards default to open, ignore retired expansion settings and preserve explicitly cleared filters", () => {
  expect(defaultBoardPreferences().filters.conditions).toEqual([openState]);
  for (const value of [{}, { filtersExpanded: null }, { filtersExpanded: true }]) {
    expect(parseBoardPreferences(JSON.stringify(value))).toEqual(defaultBoardPreferences());
  }
  // Current saves are versioned, so an explicitly cleared bar stays cleared.
  const cleared: BoardPreferences = { filters: { conjunction: "and", conditions: [] }, search: "", collapsedLanes: [], hiddenLanes: [] };
  expect(JSON.parse(serializeBoardPreferences(cleared)).version).toBe(2);
  expect(parseBoardPreferences(serializeBoardPreferences(cleared))).toEqual(cleared);
});
test("filters saved before the State chip gain the open default only where it narrows", () => {
  expect(parseFilters({ conjunction: "and", conditions: [] }).conditions).toEqual([openState]);
  expect(parseFilters({ conjunction: "and", conditions: [{ id: "default-state", field: "lane", operator: "is", value: "todo" }] }).conditions).toEqual([
    { ...openState, id: "default-state-migrated" }, { id: "default-state", field: "lane", operator: "is", value: "todo" },
  ]);
  // Blank OR drafts still behave like no filter, so the default can apply.
  expect(parseFilters({ conjunction: "or", conditions: [{ id: "draft", field: "lane", operator: "is", value: "" }] }).conditions[0]).toEqual(openState);
  const explicit: BoardPreferences["filters"] = { conjunction: "and", conditions: [{ id: "closed", field: "state", operator: "is", value: "closed" }] };
  expect(parseFilters(explicit)).toEqual(explicit);
  expect(parseSavedFilters({ conjunction: "and", conditions: [] }).conditions).toEqual([]);
});
test("legacy selections migrate into individual AND conditions", () => {
  const migrated = parseFilters({ state: "closed", lane: "custom-deleted", tags: ["bug", "feature"], users: ["missing-user", "another"], creator: "author" });
  expect(migrated.conjunction).toBe("and");
  expect(migrated.conditions.map(({ field, operator, value }) => ({ field, operator, value }))).toEqual([
    { field: "state", operator: "is", value: "closed" },
    { field: "lane", operator: "is", value: "custom-deleted" },
    { field: "labels", operator: "is", value: "label:bug" },
    { field: "labels", operator: "is", value: "label:feature" },
    { field: "tagged", operator: "is", value: "missing-user" },
    { field: "tagged", operator: "is", value: "another" },
    { field: "creator", operator: "is", value: "user:author" },
  ]);
  expect(new Set(migrated.conditions.map((condition) => condition.id)).size).toBe(7);
  expect(parseFilters(migrated)).toEqual(migrated);
});
test("all preferences round trip negative OR and unavailable selections", () => {
  const value: BoardPreferences = { filters: { conjunction: "or", conditions: [
    { id: "lane", field: "lane", operator: "isNot", value: "custom-deleted" },
    { id: "tags", field: "labels", operator: "isNot", value: "label:missing-tag" },
    { id: "users", field: "tagged", operator: "is", value: "missing-user" },
    { id: "creator", field: "creator", operator: "is", value: "user:author" },
  ] }, search: "!42", collapsedLanes: ["todo"], hiddenLanes: ["done"] };
  // An older active OR group is unchanged: an added State chip would widen it.
  expect(parseBoardPreferences(JSON.stringify(value))).toEqual(value);
  expect(parseBoardPreferences(serializeBoardPreferences(value))).toEqual(value);
});
test("modern preferences reject malformed and unsupported conditions", () => {
  const filters = parseSavedFilters({ conjunction: "and", conditions: [
    null, {}, { id: "wrong-field", field: "project", operator: "is", value: "other" },
    { id: "wrong-op", field: "lane", operator: "contains", value: "todo" },
    { id: "wrong-value", field: "tagged", operator: "is", value: 42 },
    { id: "valid", field: "state", operator: "isNot", value: "closed" },
  ] });
  expect(filters.conditions).toEqual([{ id: "valid", field: "state", operator: "isNot", value: "closed" }]);
});
test("hidden lanes migrate safely, deduplicate and remain independent of collapse", () => {
  expect(parseBoardPreferences(JSON.stringify({ collapsedLanes: ["todo"] })).hiddenLanes).toEqual([]);
  const parsed = parseBoardPreferences(JSON.stringify({ hiddenLanes: ["done", 12, null, "done"], collapsedLanes: ["todo"] }));
  expect(parsed.hiddenLanes).toEqual(["done"]);
  expect(parsed.collapsedLanes).toEqual(["todo"]);
  expect(parseBoardPreferences(serializeBoardPreferences(parsed))).toEqual(parsed);
  expect(parseBoardPreferences(JSON.stringify({ hiddenLanes: false })).hiddenLanes).toEqual([]);
});
test("empty draft rules persist and defaults are independently mutable", () => {
  const filters: BoardPreferences["filters"] = { conjunction: "or", conditions: [{ id: "draft", field: "state", operator: "isNot", value: "" }] };
  expect(parseFilters(filters)).toEqual(filters);
  const one = defaultBoardPreferences();
  one.filters.conditions.push({ id: "draft", field: "state", operator: "is", value: "" });
  expect(defaultBoardPreferences().filters.conditions).toEqual([openState]);
});
