import { expect, test } from "bun:test";
import { issuePageSizeStorageKey, normalizeIssuePageSize, readIssuePageSize } from "../src/lib/issue-pagination";

test("only supported numeric page sizes are restored", () => {
  for (const value of [10, 25, 50, 100]) expect(normalizeIssuePageSize(value)).toBe(value);
  for (const value of [null, undefined, "50", {}, [], 0, -1, 11, 1000, NaN, Infinity]) expect(normalizeIssuePageSize(value)).toBe(25);
});

test("page sizes are scoped to the user and actual list", () => {
  const key = issuePageSizeStorageKey("user-a", "project:one");
  expect(key).not.toBe(issuePageSizeStorageKey("user-b", "project:one"));
  expect(key).not.toBe(issuePageSizeStorageKey("user-a", "project:two"));
  expect(key).not.toBe(issuePageSizeStorageKey("user-a", "all"));
});

test("unavailable storage falls back to 25", () => {
  expect(readIssuePageSize("no-browser-storage")).toBe(25);
});
