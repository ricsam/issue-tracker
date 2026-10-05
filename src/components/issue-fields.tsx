import type { Issue } from "../../shared/types";
import { useWorkspace } from "../lib/workspace";

export function IssueFields({
  issue,
  onChange,
}: {
  issue: Pick<Issue, "assigneeId">;
  onChange: (patch: Partial<Issue>) => void;
}) {
  const { users } = useWorkspace();
  return (
    <div className="issue-fields">
      <label>
        Assignee
        <select
          value={issue.assigneeId || ""}
          onChange={(e) => onChange({ assigneeId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
