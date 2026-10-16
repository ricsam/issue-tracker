import { describe, expect, test } from "bun:test";
import type { Issue, User } from "../shared/types";
import { defaultIssueFilters, emptyIssueFilters, isActiveIssueFilter, issueDateKey, matchesIssueFilters, normalizeIssueFilters, type IssueFilter, type IssueFilterGroup } from "../src/lib/issue-filters";

const issue: Issue = {
  workspaceId: "default", workspaceSlug: "default", access: "full",
  id: "123", number: 123, title: "Fix the Login Flow", body: "", labels: ["bug", "urgent"],
  taggedUserIds: ["alice", "bob"], authorId: "alice", projectId: "project-a", state: "open",
  closedAt: null, closedById: null, createdAt: "2026-05-10T12:00:00Z", updatedAt: "2026-05-10T12:00:00Z",
};
const context = { users: [{ id: "alice" } as User], lane: "todo" };
const filter = (field: IssueFilter["field"], value: string, operator: IssueFilter["operator"] = "is", values?: string[]): IssueFilter => ({
  id: "rule", field, operator, value, ...(values === undefined ? {} : { values }),
});
const matches = (conditions: IssueFilter[], conjunction: IssueFilterGroup["conjunction"] = "and", target = issue, ctx: Parameters<typeof matchesIssueFilters>[2] = context) => matchesIssueFilters(target, { conjunction, conditions }, ctx);
const normalize = (conditions: unknown[], conjunction: unknown = "and") => normalizeIssueFilters({ conjunction, conditions });

describe("issue filter matching", () => {
  test("personal drafts support scalar, negated and persisted multi-state filters", () => {
    const draft: Issue = { ...issue, state: "draft" };
    expect(matchesIssueFilters(draft, defaultIssueFilters, context)).toBe(false);
    expect(matches([filter("state", "draft")], "and", draft)).toBe(true);
    expect(matches([filter("state", "draft")])).toBe(false);
    expect(matches([filter("state", "draft", "isNot")], "and", draft)).toBe(false);
    for (const condition of [filter("state", "draft"), filter("state", "", "isOneOf", ["draft", "open"])]) {
      const restored = normalizeIssueFilters(JSON.parse(JSON.stringify({ conjunction: "and", conditions: [condition] })));
      expect(restored.conditions).toEqual([condition]);
      expect(matchesIssueFilters(draft, restored, context)).toBe(true);
    }
    expect(normalize([filter("state", "private")]).conditions).toEqual([]);
  });
  test("default open filter is separate from empty filters", () => {
    expect(defaultIssueFilters).toEqual({ conjunction: "and", conditions: [{ id: "default-state", field: "state", operator: "is", value: "open" }] });
    expect(emptyIssueFilters).toEqual({ conjunction: "and", conditions: [] });
    expect(matchesIssueFilters(issue, defaultIssueFilters, context)).toBe(true);
    expect(matchesIssueFilters({ ...issue, state: "closed" }, defaultIssueFilters, context)).toBe(false);
    expect(matches([], "or", { ...issue, state: "closed" })).toBe(true);
  });

  test("scalar title and number retain contains semantics and negation", () => {
    for (const condition of [filter("title", " LOGIN "), filter("number", " !23 ")]) {
      expect(matches([condition])).toBe(true);
      expect(matches([{ ...condition, operator: "isNot" }])).toBe(false);
    }
    expect(matches([filter("title", "unrelated", "isNot")])).toBe(true);
  });

  test("AND and OR combine active positive and negative conditions", () => {
    const conditions = [filter("title", "login"), filter("state", "open", "isNot")];
    expect(matches(conditions)).toBe(false);
    expect(matches(conditions, "or")).toBe(true);
    expect(matches([filter("state", "closed"), filter("title", "unrelated")], "or")).toBe(false);
    expect(matches([filter("state", "closed", "isNot"), filter("title", "login")])).toBe(true);
  });

  test("one-of matches any selected option on all option fields", () => {
    const cases: [IssueFilter["field"], string, string][] = [
      ["labels", "label:bug", "label:missing"], ["tagged", "alice", "missing"],
      ["creator", "user:alice", "user:missing"], ["project", "project-a", "missing"],
      ["lane", "todo", "missing"], ["state", "open", "closed"],
    ];
    for (const [field, present, absent] of cases) {
      expect(matches([filter(field, "", "isOneOf", [absent, present])])).toBe(true);
      expect(matches([filter(field, present, "isOneOf", [absent])])).toBe(false);
      expect(matches([filter(field, present, "isOneOf")])).toBe(true);
      expect(matches([filter(field, absent, "isNot")])).toBe(true);
    }
  });

  test("matches-every requires all labels or tagged users", () => {
    for (const [field, values] of [["labels", ["label:bug", "label:urgent"]], ["tagged", ["alice", "bob"]]] as const) {
      expect(matches([filter(field, "", "matchesEvery", [...values])])).toBe(true);
      expect(matches([filter(field, "", "matchesEvery", [values[0], values[0]])])).toBe(true);
      const missing = field === "labels" ? "label:missing" : "missing";
      expect(matches([filter(field, "", "matchesEvery", [...values, missing])])).toBe(false);
      expect(matches([filter(field, values[0], "matchesEvery")])).toBe(true);
    }
    expect(matches([filter("labels", "", "matchesEvery", ["label:bug", "label:missing"]), filter("state", "open")], "or")).toBe(true);
  });

  test("none and unknown retain scalar semantics in multi selections", () => {
    const blank: Issue = { ...issue, labels: [], taggedUserIds: [], projectId: null, authorId: "deleted" };
    const blankContext = { users: context.users };
    for (const field of ["labels", "tagged", "project", "lane", "creator"] as const) {
      const sentinel = field === "creator" ? "unknown" : "none";
      expect(matches([filter(field, sentinel)], "and", blank, blankContext)).toBe(true);
      expect(matches([filter(field, "", "isOneOf", [sentinel])], "and", blank, blankContext)).toBe(true);
      expect(matches([filter(field, sentinel, "isNot")], "and", blank, blankContext)).toBe(false);
      expect(matches([filter(field, "", "isOneOf", [sentinel])])).toBe(false);
    }
    for (const field of ["labels", "tagged"] as const) {
      expect(matches([filter(field, "", "matchesEvery", ["none"])], "and", blank)).toBe(true);
      expect(matches([filter(field, "", "matchesEvery", ["none", field === "labels" ? "label:bug" : "alice"])], "and", blank)).toBe(false);
    }
  });

  test("empty drafts never widen OR or narrow AND, even with a stale scalar fallback", () => {
    const drafts = [filter("title", " ", "isNot"), filter("number", "!"), filter("created", ""),
      filter("state", "open", "isOneOf", []), filter("labels", "label:bug", "matchesEvery", ["", " "])];
    for (const draft of drafts) {
      expect(isActiveIssueFilter(draft)).toBe(false);
      expect(matches([draft], "or")).toBe(true);
      expect(matches([filter("state", "closed"), draft], "or")).toBe(false);
      expect(matches([filter("state", "open"), draft])).toBe(true);
    }
    expect(matches([filter("labels", "", "matchesEvery", ["", "label:bug", " "])])).toBe(true);
  });

  test("created bounds are inclusive, support one-sided ranges, and negate", () => {
    const day = issueDateKey(issue.createdAt);
    expect(matches([{ ...filter("created", day), valueTo: day }])).toBe(true);
    expect(matches([{ ...filter("created", ""), valueTo: day }])).toBe(true);
    expect(matches([{ ...filter("created", day, "isNot"), valueTo: day }])).toBe(false);
    expect(matches([filter("created", "2099-01-01")])).toBe(false);
  });
});

describe("issue filter normalization", () => {
  test("malformed input is safe and conjunction defaults to AND", () => {
    for (const input of [undefined, null, false, 0, "broken", [], {}, { conditions: {} }, { conditions: [null, 1, "rule", [], {}] }]) {
      expect(normalizeIssueFilters(input)).toEqual(emptyIssueFilters);
    }
    expect(normalize([], "invalid").conjunction).toBe("and");
    expect(normalize([], "or").conjunction).toBe("or");
  });

  test("legacy scalar filters and unavailable options round trip without new properties", () => {
    const conditions = [filter("title", "contains"), filter("number", "!12", "isNot"),
      filter("labels", "label:deleted"), filter("tagged", "deleted", "isNot"),
      filter("creator", "user:deleted"), filter("project", "deleted"), filter("lane", "deleted"),
      filter("state", "closed"), { ...filter("created", "2026-01-01"), valueTo: "2026-12-31" },
      filter("state", ""), filter("creator", "unknown"), filter("labels", "none")].map((item, index) => ({ ...item, id: `legacy-${index}` }));
    const group: IssueFilterGroup = { conjunction: "or", conditions };
    expect(normalizeIssueFilters(JSON.parse(JSON.stringify(group)))).toEqual(group);
  });

  test("multi values are deduplicated, blanks ignored, unknown valid options retained", () => {
    const group = normalize([filter("labels", "", "matchesEvery", ["label:deleted", "", "label:deleted", " ", "none"])]);
    expect(group.conditions[0]).toEqual(filter("labels", "", "matchesEvery", ["label:deleted", "none"]));
    expect(normalizeIssueFilters(JSON.parse(JSON.stringify(group)))).toEqual(group);
    expect(normalize([filter("state", "open", "isOneOf", [])]).conditions[0]?.values).toEqual([]);
    expect(normalize([filter("project", "deleted", "isOneOf")]).conditions[0]).toEqual(filter("project", "deleted", "isOneOf"));
  });

  test("rejects invalid operator/field combinations and malformed option values", () => {
    const invalid: unknown[] = [
      { ...filter("title", "x"), field: "bogus" }, { ...filter("title", "x"), operator: "contains" },
      { ...filter("tagged", "x"), value: 3 },
      ...["title", "number", "created"].map((field) => ({ ...filter("title", ""), field, operator: "isOneOf", values: [] })),
      ...["title", "number", "created", "creator", "project", "lane", "state"].map((field) => ({ ...filter("title", ""), field, operator: "matchesEvery", values: [] })),
      filter("labels", "bug"), filter("labels", "label:"), filter("labels", "label: "),
      filter("creator", "alice"), filter("creator", "user:"), filter("creator", "user: "), filter("state", "unknown"),
      filter("labels", "", "isOneOf", ["label:bug", "malformed"]), filter("state", "", "isOneOf", ["open", "invalid"]),
      ...[null, {}, "alice", ["alice", 2], [null]].map((values) => ({ ...filter("tagged", "", "isOneOf"), values })),
    ];
    expect(normalize(invalid).conditions).toEqual([]);
    expect(normalizeIssueFilters({ conditions: [filter("project", "p"), filter("state", "open")] }, ["state"]).conditions).toEqual([filter("state", "open")]);
  });

  test("dates validate real calendar days and only created retains valueTo", () => {
    expect(normalize([{ ...filter("created", "2026-02-30"), valueTo: "2026-13-01" }]).conditions[0]).toEqual({ ...filter("created", ""), valueTo: "" });
    expect(normalize([{ ...filter("created", "2024-02-29"), valueTo: "2026-12-01" }]).conditions[0]?.value).toBe("2024-02-29");
    expect(normalize([{ ...filter("title", "login"), valueTo: "ignored", values: ["ignored"] }]).conditions[0]).toEqual(filter("title", "login"));
  });

  test("IDs are unique and deterministic and normalization is idempotent", () => {
    const group = normalize([filter("state", "open"), filter("state", "closed"), { ...filter("title", "x"), id: "" }, { ...filter("title", "y"), id: null }]);
    expect(group.conditions.map(({ id }) => id)).toEqual(["rule", "rule-duplicate", "filter-2", "filter-3"]);
    expect(normalizeIssueFilters(group)).toEqual(group);
  });
});
