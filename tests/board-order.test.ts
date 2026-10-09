import { expect, test } from "bun:test";
import { boardDropAnchor, boardOrderTarget } from "../src/lib/board-order";
import { boardArrowTarget, boardSelectionRange } from "../src/lib/board-selection";

test("board arrows follow visible rows and lanes, stop at boundaries and skip empty lanes", () => {
  const columns = [["a", "b", "c", "d"], [], ["e", "f"], ["g"]];
  expect(boardArrowTarget(columns, "b", "ArrowDown")).toBe("c");
  expect(boardArrowTarget(columns, "b", "ArrowDown", true)).toBe("d");
  expect(boardArrowTarget(columns, "c", "ArrowUp", true)).toBe("a");
  expect(boardArrowTarget(columns, "a", "ArrowUp")).toBe("a");
  expect(boardArrowTarget(columns, "d", "ArrowDown")).toBe("d");
  expect(boardArrowTarget(columns, "c", "ArrowRight")).toBe("f");
  expect(boardArrowTarget(columns, "f", "ArrowLeft")).toBe("b");
  expect(boardArrowTarget(columns, "b", "ArrowRight", true)).toBe("g");
  expect(boardArrowTarget(columns, "g", "ArrowLeft", true)).toBe("a");
  expect(boardArrowTarget(columns, "g", "ArrowRight")).toBe("g");
  expect(boardArrowTarget(columns, "missing", "ArrowUp")).toBeUndefined();
  expect(boardArrowTarget([], "a", "ArrowUp")).toBeUndefined();
});

test("board ranges can grow and shrink within or across uneven visible lanes", () => {
  const columns = [["a", "b", "c"], [], ["d", "e"], ["f", "g", "h"]];
  expect(boardSelectionRange(columns, "a", "c")).toEqual(["a", "b", "c"]);
  expect(boardSelectionRange(columns, "c", "b")).toEqual(["b", "c"]);
  expect(boardSelectionRange(columns, "a", "e")).toEqual(["a", "b", "d", "e"]);
  expect(boardSelectionRange(columns, "h", "a")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(boardSelectionRange(columns, "a", "a")).toEqual(["a"]);
  expect(boardSelectionRange(columns, "a", "missing")).toEqual([]);
});

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
