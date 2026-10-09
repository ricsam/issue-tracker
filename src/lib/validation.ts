import { ISSUE_BODY_MAX_LENGTH } from "../../shared/issue-content";

export function validateIssueBody(body: string) {
  if (!body.trim()) throw new Error("Write something about the issue first.");
  if (body.length > ISSUE_BODY_MAX_LENGTH)
    throw new Error(
      `Issue must be at most ${ISSUE_BODY_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    );
}

export function validateBody(body: string) {
  if (body.length > 100000)
    throw new Error("Body must be at most 100,000 characters.");
}
