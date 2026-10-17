import { z } from "zod";
import { issueFilterFields, normalizeIssueFilters, type IssueFilterField } from "../shared/issue-filters";

/** Unlike tolerant browser-storage migration, API writes reject malformed input. */
export function issueFiltersField(allowProject = true) {
  const allowed = issueFilterFields.filter((field) => allowProject || field !== "project");
  return z.object({
    conjunction: z.enum(["and", "or"]),
    conditions: z.array(z.object({
      id: z.string().min(1).max(100),
      field: z.enum(issueFilterFields),
      operator: z.enum(["is", "isNot", "isOneOf", "matchesEvery"]),
      value: z.string().max(1000),
      values: z.array(z.string().max(1000)).max(100).optional(),
      valueTo: z.string().max(10).optional(),
    }).strict()).max(50),
  }).strict().superRefine((group, ctx) => {
    const ids = new Set<string>();
    for (const condition of group.conditions) {
      const normalized = normalizeIssueFilters({ conjunction: group.conjunction, conditions: [condition] }, allowed as IssueFilterField[]).conditions[0];
      if (ids.has(condition.id) || !normalized
        || (condition.valueTo !== undefined && condition.field !== "created")
        || (condition.values !== undefined && condition.operator !== "isOneOf" && condition.operator !== "matchesEvery")
        || (condition.field === "created" && (normalized.value !== condition.value || (condition.valueTo !== undefined && normalized.valueTo !== condition.valueTo)))
        || (condition.values && new Set(condition.values).size !== condition.values.length)) {
        ctx.addIssue({ code: "custom", message: "Invalid issue filter" });
      }
      ids.add(condition.id);
    }
  });
}
