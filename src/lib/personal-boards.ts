import type { BoardSettings, Issue, PersonalBoard } from "../../shared/types";
export type { PersonalBoard } from "../../shared/types";
export type PersonalBoardConfig = Pick<
  PersonalBoard,
  | "name"
  | "filters"
  | "search"
  | "lanes"
  | "customLanes"
  | "laneLabels"
  | "cards"
  | "collapsedLanes"
  | "hiddenLanes"
>;
export function boardConfig(board: PersonalBoardConfig): PersonalBoardConfig {
  return {
    name: board.name,
    filters: board.filters,
    search: board.search,
    lanes: board.lanes,
    customLanes: board.customLanes,
    laneLabels: board.laneLabels || {},
    cards: board.cards,
    collapsedLanes: board.collapsedLanes,
    hiddenLanes: board.hiddenLanes,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
// Compare exactly what JSON sends: undefined object properties disappear,
// undefined array entries become null, and object key order is immaterial.
const wireConfig = (board: PersonalBoardConfig): PersonalBoardConfig =>
  JSON.parse(JSON.stringify(boardConfig(board)));
const equal = (a: PersonalBoardConfig, b: PersonalBoardConfig) =>
  canonical(wireConfig(a)) === canonical(wireConfig(b));
export type SaveState = "saved" | "saving" | "error" | "conflict";
/** One in-flight write, latest desired snapshot retained separately from acknowledgements. */
export class PersonalBoardSaveQueue {
  private acknowledged: PersonalBoard;
  private desired: PersonalBoardConfig;
  private attempted: PersonalBoardConfig | null = null;
  private active = true;
  private running = false;
  private stopped = false;
  constructor(
    board: PersonalBoard,
    private patch: (
      config: PersonalBoardConfig,
      revision: number,
    ) => Promise<PersonalBoard>,
    private read: () => Promise<PersonalBoard>,
    private report: (state: SaveState, error?: string) => void,
  ) {
    this.acknowledged = board;
    this.desired = wireConfig(board);
  }
  dispose() {
    this.active = false;
  }
  update(config: PersonalBoardConfig) {
    this.desired = wireConfig(config);
    if (!this.stopped) void this.flush();
  }
  private async flush() {
    if (!this.active || this.running || this.stopped) return;
    if (equal(this.desired, this.acknowledged)) {
      this.report("saved");
      return;
    }
    this.running = true;
    this.report("saving");
    try {
      while (this.active && !equal(this.desired, this.acknowledged)) {
        this.attempted = this.desired;
        const sent = this.attempted;
        this.acknowledged = await this.patch(sent, this.acknowledged.revision);
        // A successful response is authoritative for this submitted intent.
        // The server may trim names or normalize filters. Do not resend the
        // same intent forever, but never replace edits queued during the await.
        if (equal(this.desired, sent))
          this.desired = wireConfig(this.acknowledged);
      }
      if (this.active) this.report("saved");
    } catch (error) {
      this.stopped = true;
      if (this.active)
        this.report(
          "error",
          error instanceof Error ? error.message : "Could not save board.",
        );
    } finally {
      this.running = false;
    }
  }
  async retry() {
    if (!this.active || this.running) return;
    this.running = true;
    this.report("saving");
    try {
      const remote = await this.read();
      if (!this.active) return;
      // A response may have been lost after a successful write. Only retry when
      // the server still contains our baseline or the exact attempted snapshot.
      if (
        !equal(remote, this.acknowledged) &&
        !(this.attempted && equal(remote, this.attempted))
      ) {
        this.report(
          "conflict",
          "This board changed in another tab. Reload the saved version to continue; your unsaved changes have not overwritten it.",
        );
        return;
      }
      this.acknowledged = remote;
      this.stopped = false;
    } catch (error) {
      this.report(
        "error",
        error instanceof Error
          ? error.message
          : "Could not check the saved board.",
      );
    } finally {
      this.running = false;
    }
    if (!this.stopped) await this.flush();
  }
}

export function personalLane(
  issue: Pick<Issue, "id" | "state">,
  board: BoardSettings,
) {
  const override = board.cards.find((card) => card.issueId === issue.id)?.lane;
  return override && board.lanes.includes(override)
    ? override
    : issue.state === "closed" && board.lanes.includes("done")
      ? "done"
      : board.lanes[0];
}
export function removePersonalLane(
  board: PersonalBoardConfig,
  lane: string,
): PersonalBoardConfig {
  if (board.lanes.length <= 1) return board;
  const lanes = board.lanes.filter((value) => value !== lane);
  const laneLabels = { ...board.laneLabels };
  delete laneLabels[lane];
  return {
    ...board,
    lanes,
    laneLabels,
    customLanes: board.customLanes.filter((item) => item.value !== lane),
    cards: board.cards.map((card) =>
      card.lane === lane ? { ...card, lane: lanes[0] } : card,
    ),
    hiddenLanes: board.hiddenLanes.filter(
      (value) => value !== lane && value !== lanes[0],
    ),
    collapsedLanes: board.collapsedLanes.filter((value) => value !== lane),
  };
}
