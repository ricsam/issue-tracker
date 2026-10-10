import { afterEach, describe, expect, test } from "bun:test";
import type { BoardSettings, Project } from "../shared/types";
import { creationLane, creationProject, readCreationPreferences, rememberCreationSelection } from "../src/lib/issue-creation-preferences";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function storage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  return values;
}
describe("creation preferences", () => {
  test("isolates users and retains lane choices per project including explicit empty choices", () => {
    storage();
    rememberCreationSelection("alice", { projectId: "a", lane: { projectId: "a", value: "todo" } });
    rememberCreationSelection("alice", { lane: { projectId: "b", value: "done" } });
    expect(readCreationPreferences("alice")).toEqual({ projectId: "a", lanes: { a: "todo", b: "done" } });
    expect(readCreationPreferences("bob")).toEqual({ projectId: "", lanes: {} });
    rememberCreationSelection("alice", { projectId: "", lane: { projectId: "a", value: "" } });
    expect(readCreationPreferences("alice")).toEqual({ projectId: "", lanes: { a: "", b: "done" } });
  });
  test("corrupt and unavailable storage do not prevent creation", () => {
    const values = storage();
    values.set("issue-tracker:create-issue:alice", "bad json");
    expect(readCreationPreferences("alice")).toEqual({ projectId: "", lanes: {} });
    values.set("issue-tracker:create-issue:alice", JSON.stringify({ projectId: 4, lanes: { a: "todo", b: false } }));
    expect(readCreationPreferences("alice")).toEqual({ projectId: "", lanes: { a: "todo" } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    expect(readCreationPreferences("alice")).toEqual({ projectId: "", lanes: {} });
    expect(() => rememberCreationSelection("alice", { projectId: "a" })).not.toThrow();
  });
  test("context overrides global preference; archived or missing projects fall back to no project", () => {
    const projects = [{ id: "a", archivedAt: null }, { id: "b", archivedAt: null }, { id: "old", archivedAt: "today" }] as Project[];
    expect(creationProject(projects, "a")).toBe("a");
    expect(creationProject(projects, "a", projects[1])).toBe("b");
    expect(creationProject(projects, "old")).toBe("");
    expect(creationProject(projects, "missing")).toBe("");
    expect(creationProject(projects, "a", projects[2])).toBe("");
  });
  test("only current visible lanes are restored, including custom lanes", () => {
    const board = { lanes: ["todo", "custom_review"], customLanes: [{ value: "custom_review", label: "Review" }] } as BoardSettings;
    expect(creationLane(board, "todo")).toBe("todo");
    expect(creationLane(board, "custom_review")).toBe("custom_review");
    for (const lane of ["done", "custom_deleted", ""]) expect(creationLane(board, lane)).toBe("");
    expect(creationLane(undefined, "todo")).toBe("");
  });
});
