export type PluginField = {
  name: string;
  label: string;
  type: "text" | "url" | "select" | "secret" | "project-table";
  options?: { value: string; label: string }[];
  columns?: { name: string; label: string; type: "text" | "url" }[];
  required?: boolean;
};
export type PluginMetadata = {
  id: string;
  name: string;
  description: string;
  fields: PluginField[];
};
export type PluginAdminSettings = PluginMetadata & {
  enabled: boolean;
  values: Record<string, unknown>;
  hasSecrets: Record<string, boolean>;
  status: { state: string; error?: string };
};
export type PluginPublicSettings = {
  id: string;
  values: Record<string, unknown>;
};
export type ExternalLink = {
  pluginId: string;
  externalId: string;
  title: string;
  url: string;
  status: string | null;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
};
export type PluginEvent = {
  type:
    | "issue.created"
    | "issue.updated"
    | "issue.closed"
    | "issue.reopened"
    | "comment.created"
    | "card.moved";
  issueId: string;
  actorId: string;
  commentId?: string;
};
/** The compiled first-party registry's browser-safe metadata. Never include credentials here. */
export const pluginRegistry: PluginMetadata[] = [
  {
    id: "r5d",
    name: "r5d",
    description: "Implement issues with r5d and follow shared team sessions.",
    fields: [
      { name: "baseUrl", label: "r5d base URL", type: "url", required: true },
      { name: "team", label: "Team URL name", type: "text", required: true },
      { name: "apiKey", label: "Team API key", type: "secret", required: true },
      {
        name: "defaultShare",
        label: "Default share",
        type: "select",
        options: [
          { value: "none", label: "None" },
          { value: "session", label: "This session" },
          { value: "branch", label: "All sessions on the branch" },
          { value: "project", label: "All sessions in the project" },
        ],
      },
      {
        name: "projects",
        label: "Project mappings",
        type: "project-table",
        columns: [
          { name: "remote", label: "Git remote", type: "text" },
          { name: "defaultBranch", label: "Default branch", type: "text" },
        ],
      },
    ],
  },
];
