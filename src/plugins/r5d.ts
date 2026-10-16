import type { Comment, Issue, User } from "../../shared/types";
import type { PluginPublicSettings } from "../../shared/plugins";

export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export interface IssueActionContext {
  issue: Issue;
  comments: Comment[];
  users: User[];
  baseUrl: string;
}

export async function r5dLaunchUrl(settings: PluginPublicSettings, context: IssueActionContext): Promise<string> {
  const { issue, comments, users } = context;
  const base = httpUrl(context.baseUrl);
  const target = httpUrl(settings.values.baseUrl);
  if (!base || !target) throw new Error("The integration requires valid HTTP(S) base URLs.");
  const mappings = Array.isArray(settings.values.projects) ? settings.values.projects : [];
  const mapping = mappings.find((row) => row && row.projectId === issue.projectId);
  const title = issue.title.slice(0, 500);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const name = `issue/${issue.number}${slug ? `-${slug}` : ""}`.slice(0, 40).replace(/-$/, "");
  const snapshot = [issue.body, ...comments.map((comment) => `\n\n## Comment by ${users.find((user) => user.id === comment.authorId)?.name || "Unknown author"} (${comment.createdAt})\n\n${comment.body}`)].join("").slice(0, 100000);
  // Propose the connected team; r5d resolves existing shares and asks per launch.
  // An installation's former defaultShare must not determine this choice.
  const team = settings.values.team;
  const payload = {
    v: 1,
    ...(mapping && typeof mapping.remote === "string" && typeof mapping.defaultBranch === "string" ? {
      remote: mapping.remote,
      branch: { mode: "new", name, from: mapping.defaultBranch },
    } : {}),
    workItems: [{ source: "threadline", id: `${new URL(base).host}#${issue.number}`, kind: "issue", url: `${base.replace(/\/$/, "")}/issues/${issue.number}`, title, snapshot }],
    ...(typeof team === "string" && team ? { share: { team, scope: "branch" } } : {}),
  };
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("deflate"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${target.replace(/\/$/, "")}/launch#${encoded}`;
}
