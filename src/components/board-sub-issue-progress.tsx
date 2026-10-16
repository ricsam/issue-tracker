import type { CSSProperties } from "react";
import type { SubIssueProgress } from "../../shared/types";
import "./board-sub-issue-progress.css";

/** A single lightweight bar, with one segment per child up to 20 segments. */
export function BoardSubIssueProgress({ issueNumber, progress }: { issueNumber: number; progress?: SubIssueProgress }) {
  if (!progress || progress.total <= 0) return null;
  const { total } = progress;
  const closed = Math.min(total, Math.max(0, progress.closed));
  const percent = closed === total ? 100 : Math.min(99, Math.round(closed / total * 100));
  return <span className="board-sub-issue-progress" role="progressbar"
    aria-label={`Sub-issues for issue !${issueNumber}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={closed}
    aria-valuetext={`${closed} of ${total} sub-issues closed (${percent}%)`}>
    <span className="board-sub-issue-count" aria-hidden="true">{closed} / {total}</span>
    <span className="board-sub-issue-track" aria-hidden="true" style={{
      "--sub-issue-segments": Math.min(total, 20),
      "--sub-issue-completion": `${closed / total * 100}%`,
    } as CSSProperties} />
    <span className="board-sub-issue-percent" aria-hidden="true">{percent}%</span>
  </span>;
}
