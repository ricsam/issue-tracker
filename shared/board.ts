import { LANES, type BoardLane, type Lane } from "./types";

/** Lane definitions for the visible `lanes`, in board display order. */
export function orderedLanes(lanes: Lane[], customLanes: BoardLane[]): BoardLane[] {
  const definitions = new Map(
    [...LANES, ...customLanes].map((lane) => [lane.value, lane]),
  );
  return lanes.flatMap((value) => definitions.get(value) ?? []);
}

/** A copy of `lanes` with `lane` moved to `index`, clamped to the list bounds. */
export function moveLaneTo(lanes: Lane[], lane: Lane, index: number): Lane[] {
  const rest = lanes.filter((value) => value !== lane);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, lane);
  return rest;
}
