import type { BoardCard } from "../../shared/types";

/** Resolve a drop against the complete lane, not just the search-visible cards. */
export function boardDropAnchor(cards: BoardCard[], movingIds: string[], lane: string, targetId: string, after: boolean): string | null | undefined {
  const remaining = cards.filter((card) => card.lane === lane && !movingIds.includes(card.issueId));
  const index = remaining.findIndex((card) => card.issueId === targetId);
  if (index < 0) return undefined;
  return remaining[index + (after ? 1 : 0)]?.issueId ?? null;
}

export type BoardOrderAction = "up" | "down" | "top" | "bottom";

/** Move a same-lane selection as a block, preserving its existing relative order. */
export function boardOrderTarget(cards: BoardCard[], movingIds: string[], action: BoardOrderAction): { lane: string; beforeIssueId: string | null } | undefined {
  const selected = cards.filter((card) => movingIds.includes(card.issueId));
  const lane = selected[0]?.lane;
  if (!lane || selected.length !== movingIds.length || selected.some((card) => card.lane !== lane)) return;
  const laneCards = cards.filter((card) => card.lane === lane);
  const remaining = laneCards.filter((card) => !movingIds.includes(card.issueId));
  if (!remaining.length) return;
  let beforeIssueId: string | null;
  if (action === "top") beforeIssueId = remaining[0].issueId;
  else if (action === "bottom") beforeIssueId = null;
  else if (action === "up") {
    const first = laneCards.findIndex((card) => card.issueId === selected[0].issueId);
    if (first === 0) return;
    beforeIssueId = laneCards[first - 1].issueId;
  } else {
    const last = laneCards.findIndex((card) => card.issueId === selected[selected.length - 1].issueId);
    if (last === laneCards.length - 1) return;
    const next = remaining.findIndex((card) => card.issueId === laneCards[last + 1].issueId);
    beforeIssueId = remaining[next + 1]?.issueId ?? null;
  }
  const result = remaining.map((card) => card.issueId);
  const at = beforeIssueId === null ? result.length : result.indexOf(beforeIssueId);
  result.splice(at, 0, ...selected.map((card) => card.issueId));
  if (result.every((id, index) => id === laneCards[index].issueId)) return;
  return { lane, beforeIssueId };
}
