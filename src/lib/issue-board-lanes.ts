import { LANES, type BoardSettings, type Project } from "../../shared/types";

export interface IssueBoardLane {
  value: string;
  label: string;
  hidden: boolean;
}
export interface BoardLaneOption {
  value: string;
  label: string;
}
export function boardLaneKey(projectId: string, lane: string) {
  return JSON.stringify([projectId, lane]);
}

/** Resolve real board membership, including hidden lanes, never issue lifecycle state. */
export function issueBoardLanes(boards: Record<string, BoardSettings>) {
  const lanes = new Map<string, IssueBoardLane>();
  for (const [projectId, board] of Object.entries(boards)) {
    const definitions = new Map([...LANES, ...board.customLanes].map((lane) => [lane.value, lane.label]));
    for (const card of board.cards) lanes.set(card.issueId, {
      value: boardLaneKey(projectId, card.lane),
      label: definitions.get(card.lane) || card.lane,
      hidden: !board.lanes.includes(card.lane),
    });
  }
  return lanes;
}

export function boardLaneOptions(boards: Record<string, BoardSettings>, projects: Project[], includeProject: boolean): BoardLaneOption[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return Object.entries(boards).flatMap(([projectId, board]) => {
    const definitions = new Map([...LANES, ...board.customLanes].map((lane) => [lane.value, lane.label]));
    const values = [...new Set([...board.lanes, ...board.cards.map((card) => card.lane)])];
    return values.map((lane) => ({
      value: boardLaneKey(projectId, lane),
      label: `${includeProject ? `${names.get(projectId) || "Unknown project"} · ` : ""}${definitions.get(lane) || lane}${board.lanes.includes(lane) ? "" : " (hidden)"}`,
    }));
  }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) || a.value.localeCompare(b.value));
}
