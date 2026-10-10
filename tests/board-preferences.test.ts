import { expect, test } from "bun:test";
import { boardPreferencesKey, defaultBoardPreferences, parseBoardPreferences } from "../src/components/board-preferences";

test("board preferences are scoped to user and stable board ID", () => {
  expect(boardPreferencesKey("one", "board")).not.toBe(boardPreferencesKey("two", "board"));
  expect(boardPreferencesKey("one", "board")).not.toBe(boardPreferencesKey("one", "other"));
  expect(boardPreferencesKey("a:b", "c")).not.toBe(boardPreferencesKey("a", "b:c"));
});
test("malformed or missing preferences safely default", () => {
  for (const raw of [null, "broken", "null", "42"]) expect(parseBoardPreferences(raw)).toEqual(defaultBoardPreferences());
  expect(parseBoardPreferences(JSON.stringify({ filters: { state: "bad", tags: ["bug", 4, "bug"], users: false }, collapsedLanes: ["todo", null, "todo"], search: 42, filtersExpanded: "false" }))).toEqual({ ...defaultBoardPreferences(), filters: { ...defaultBoardPreferences().filters, tags: ["bug"] }, collapsedLanes: ["todo"] });
});
test("all preferences round trip including unavailable selections", () => {
  const value = { filters: { state: "closed" as const, lane: "custom-deleted", tags: ["bug"], users: ["missing-user"], creator: "author" }, search: "!42", filtersExpanded: false, collapsedLanes: ["todo"] };
  expect(parseBoardPreferences(JSON.stringify(value))).toEqual(value);
});
