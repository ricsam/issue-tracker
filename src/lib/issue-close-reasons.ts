import type { IssueCloseReason } from "../../shared/types";

export const closeReasonLabels: Record<IssueCloseReason, string> = {
  completed: "Completed",
  not_planned: "Not planned",
  duplicate: "Duplicate",
};
