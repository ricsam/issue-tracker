import type { WorkspacePermissions } from "./types";

export const canCreateIssues = (permissions: WorkspacePermissions | null | undefined) =>
  permissions === "full" || permissions === "create-issue" || permissions === "read+create-issue";

export const canReadAllIssues = (permissions: WorkspacePermissions | null | undefined) =>
  permissions === "full" || permissions === "read" || permissions === "read+create-issue";

export const permissionLabel = (permissions: WorkspacePermissions | null | undefined): string => ({
  none: "None",
  read: "Read",
  "create-issue": "Create issues",
  "read+create-issue": "Read + create issues",
  full: "Full",
})[permissions ?? "none"];
