import { describe, expect, test } from "bun:test";
import {
  boardConfig,
  PersonalBoardSaveQueue,
  personalLane,
  removePersonalLane,
  type PersonalBoard,
  type PersonalBoardConfig,
} from "../src/lib/personal-boards";
const initial = (): PersonalBoard => ({
  id: "b",
  userId: "u",
  workspaceId: "w",
  name: "Focus",
  filters: { conjunction: "and", conditions: [] },
  search: "",
  lanes: ["backlog", "done"],
  customLanes: [],
  cards: [],
  collapsedLanes: [],
  hiddenLanes: [],
  revision: 1,
  createdAt: "",
  updatedAt: "",
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("personal board placement", () => {
  test("unplaced issues remain visible and closed defaults to done", () => {
    const board = initial();
    expect(personalLane({ id: "1", state: "open" }, board)).toBe("backlog");
    expect(personalLane({ id: "1", state: "closed" }, board)).toBe("done");
    board.cards = [{ issueId: "1", lane: "backlog" }];
    expect(personalLane({ id: "1", state: "closed" }, board)).toBe("backlog");
  });
  test("remove lane keeps issues in fallback and cannot remove last lane", () => {
    const board = initial();
    board.cards = [{ issueId: "1", lane: "done" }];
    const next = removePersonalLane(board, "done");
    expect(next.cards).toEqual([{ issueId: "1", lane: "backlog" }]);
    expect(removePersonalLane(next, "backlog")).toBe(next);
  });
});
describe("serialized personal board saves", () => {
  test("undefined filter properties serialize away and produce exactly one write", async () => {
    let writes = 0;
    let state = "";
    const queue = new PersonalBoardSaveQueue(
      initial(),
      async (config, revision) => {
        if (++writes > 1) throw Error("Unexpected repeated write");
        expect(config.filters.conditions[0]).not.toHaveProperty("values");
        expect(config.filters.conditions[0]).not.toHaveProperty("valueTo");
        return JSON.parse(
          JSON.stringify({ ...initial(), ...config, revision: revision + 1 }),
        );
      },
      async () => initial(),
      (value) => {
        state = value;
      },
    );
    const config: PersonalBoardConfig = {
      ...boardConfig(initial()),
      filters: {
        conjunction: "and",
        conditions: [
          {
            id: "filter",
            field: "project",
            operator: "is",
            value: "p",
            values: undefined,
            valueTo: undefined,
          },
        ],
      },
    };
    queue.update(config);
    await tick();
    expect(writes).toBe(1);
    expect(state).toBe("saved");
    queue.update(config);
    await tick();
    expect(writes).toBe(1);
    queue.dispose();
  });
  test("successful server normalization does not repeatedly resubmit unchanged intent", async () => {
    let writes = 0;
    let state = "";
    const queue = new PersonalBoardSaveQueue(
      initial(),
      async (config, revision) => {
        if (++writes > 1) throw Error("Unexpected repeated write");
        return {
          ...initial(),
          ...config,
          name: config.name.trim(),
          revision: revision + 1,
        };
      },
      async () => initial(),
      (value) => {
        state = value;
      },
    );
    queue.update({ ...boardConfig(initial()), name: "  Normalized  " });
    await tick();
    expect(writes).toBe(1);
    expect(state).toBe("saved");
    queue.dispose();
  });
  test("coalesces edits made in flight and advances revision without replacing newer intent", async () => {
    const calls: { config: PersonalBoardConfig; revision: number }[] = [];
    const resolves: ((board: PersonalBoard) => void)[] = [];
    const queue = new PersonalBoardSaveQueue(
      initial(),
      (config, revision) => {
        calls.push({ config, revision });
        return new Promise((resolve) => resolves.push(resolve));
      },
      async () => initial(),
      () => {},
    );
    queue.update({ ...boardConfig(initial()), search: "a" });
    queue.update({ ...boardConfig(initial()), search: "abc" });
    expect(calls).toHaveLength(1);
    resolves[0]({ ...initial(), ...calls[0].config, revision: 2 });
    await tick();
    expect(calls[1].config.search).toBe("abc");
    expect(calls[1].revision).toBe(2);
    resolves[1]({ ...initial(), ...calls[1].config, revision: 3 });
    await tick();
    queue.dispose();
  });
  test("lost successful response reconciles before retrying latest edits", async () => {
    let remote = initial();
    let count = 0;
    let state = "";
    const queue = new PersonalBoardSaveQueue(
      initial(),
      async (config, revision) => {
        count++;
        remote = { ...remote, ...config, revision: revision + 1 };
        if (count === 1) throw Error("offline");
        return remote;
      },
      async () => remote,
      (value) => {
        state = value;
      },
    );
    queue.update({ ...boardConfig(initial()), search: "a" });
    await tick();
    queue.update({ ...boardConfig(initial()), search: "ab" });
    await queue.retry();
    expect(remote.search).toBe("ab");
    expect(remote.revision).toBe(3);
    expect(state).toBe("saved");
  });
  test("conflicting remote changes are never overwritten", async () => {
    let writes = 0;
    let state = "";
    const queue = new PersonalBoardSaveQueue(
      initial(),
      async () => {
        writes++;
        throw Error("conflict");
      },
      async () => ({ ...initial(), name: "Other tab", revision: 2 }),
      (value) => {
        state = value;
      },
    );
    queue.update({ ...boardConfig(initial()), search: "mine" });
    await tick();
    await queue.retry();
    expect(state).toBe("conflict");
    expect(writes).toBe(1);
  });
  test("dispose prevents queued work from starting in another scope", async () => {
    let writes = 0;
    let finish!: (board: PersonalBoard) => void;
    const queue = new PersonalBoardSaveQueue(
      initial(),
      async () => {
        writes++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      async () => initial(),
      () => {},
    );
    queue.update({ ...boardConfig(initial()), search: "a" });
    queue.update({ ...boardConfig(initial()), search: "b" });
    queue.dispose();
    finish({ ...initial(), search: "a", revision: 2 });
    await tick();
    expect(writes).toBe(1);
  });
});
