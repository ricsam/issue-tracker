import { expect, test } from "bun:test";
import { boardDropAnchor, boardOrderTarget } from "../src/lib/board-order";

const cards = ["a", "b", "c", "d", "e"].map((issueId) => ({ issueId, lane: "todo" }));
cards.push({ issueId: "z", lane: "done" });

test("card drop uses full lane anchors, excluding the moving selection", () => {
  expect(boardDropAnchor(cards, ["e"], "todo", "b", false)).toBe("b");
  expect(boardDropAnchor(cards, ["e"], "todo", "b", true)).toBe("c");
  expect(boardDropAnchor(cards, ["e", "c"], "todo", "b", true)).toBe("d");
  expect(boardDropAnchor(cards, ["a"], "todo", "e", true)).toBeNull();
  expect(boardDropAnchor(cards, ["a"], "todo", "a", false)).toBeUndefined();
  expect(boardDropAnchor(cards, ["a"], "done", "b", false)).toBeUndefined();
});

test("menu order moves same-lane groups while preserving hidden cards and disabling no-ops", () => {
  expect(boardOrderTarget(cards, ["b", "c"], "up")).toEqual({ lane: "todo", beforeIssueId: "a" });
  expect(boardOrderTarget(cards, ["b", "c"], "down")).toEqual({ lane: "todo", beforeIssueId: "e" });
  expect(boardOrderTarget(cards, ["b", "d"], "top")).toEqual({ lane: "todo", beforeIssueId: "a" });
  expect(boardOrderTarget(cards, ["b", "d"], "bottom")).toEqual({ lane: "todo", beforeIssueId: null });
  expect(boardOrderTarget(cards, ["d", "e"], "down")).toBeUndefined();
  expect(boardOrderTarget(cards, ["a", "b"], "top")).toBeUndefined();
  expect(boardOrderTarget(cards, ["d", "e"], "bottom")).toBeUndefined();
  expect(boardOrderTarget(cards, ["a", "z"], "up")).toBeUndefined();
  expect(boardOrderTarget(cards, [], "top")).toBeUndefined();
  expect(boardOrderTarget(cards, ["missing"], "top")).toBeUndefined();
});
