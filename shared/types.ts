import type { ExternalLink } from "./plugins";

export type Role = "admin" | "member";
export type WorkspaceAccess = "none" | "read" | "full";
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  visibility: "public" | "hidden";
  role: Role | null;
  defaultAccess: WorkspaceAccess;
  canManage: boolean;
}
export interface WorkspaceProjectAccess { projectId: string; access: "read" | "full" }
export interface WorkspaceMember {
  userId: string;
  id: string;
  name: string;
  email: string;
  role: Role;
  defaultAccess: WorkspaceAccess;
  /** Migrated private-project protections remain until explicitly converted. */
  legacyAccess: boolean;
  projectAccess: WorkspaceProjectAccess[];
}
export interface WorkspaceInvitation {
  id: string;
  email: string;
  defaultAccess: WorkspaceAccess;
  projectAccess: WorkspaceProjectAccess[];
  createdAt: string;
}
export type Lane = string;
export type IssueCloseReason = "completed" | "not_planned" | "duplicate";
export type IssueState = "open" | "closed" | "draft";
export interface BoardLane {
  value: Lane;
  label: string;
}
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
  /** Request-local scope, never a persisted account attribute. */
  workspaceId?: string;
  workspaceSlug?: string;
}
export interface Project {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  /** Null only in a successful ACL update that revoked the caller's access. */
  access: "read" | "full" | null;
  slug: string;
  name: string;
  description: string;
  /** Legacy project protection within a workspace; never grants nonmember access. */
  visibility: "public" | "private";
  /** Legacy projects without any accounts may have no owner until an admin assigns one. */
  ownerId: string | null;
  sharedUserIds: string[];
  createdAt: string;
  /** Archived projects are hidden from navigation and read-only until restored. */
  archivedAt: string | null;
  archivedById: string | null;
  /** Latest updatedAt among issues in this project visible to the current user. */
  lastIssueUpdatedAt: string | null;
  issueCount: number;
  openCount: number;
}
export interface BoardCard {
  issueId: string;
  lane: Lane;
}
export interface SubIssueProgress {
  total: number;
  closed: number;
}
export interface BoardSettings {
  lanes: Lane[];
  customLanes: BoardLane[];
  /** Display-only overrides for built-in and custom lanes; omitted when empty. */
  laneLabels?: Record<string, string>;
  /** Array order defines the saved card order within each lane. */
  cards: BoardCard[];
}
export type IssueReference = Pick<Issue, "id" | "number" | "title" | "state">;
export interface IssueRelationships {
  parent: IssueReference | null;
  subIssues: IssueReference[];
}
export interface Issue {
  /** Stable internal key, not a display number or canonical URL segment. */
  id: string;
  /** Independent sequential number within the workspace. */
  number: number;
  workspaceId: string;
  workspaceSlug: string;
  access: "read" | "full";
  projectId: string | null;
  title: string;
  body: string;
  labels: string[];
  taggedUserIds: string[];
  /** Plugin links inherit the issue's current access; absent in older clients. */
  externalLinks?: ExternalLink[];
  authorId: string;
  /** Personal drafts are creator-only; published state derives from closedAt. */
  state: IssueState;
  closedAt: string | null;
  closedById: string | null;
  closeReason?: IssueCloseReason | null;
  duplicateOfId?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface IssueHistoryEntry {
  id: number;
  issueId: string;
  actorId: string;
  createdAt: string;
  action: "created" | "updated" | "commented" | "comment_edited" | "comment_deleted";
  changes: {
    field: "body" | "state" | "project" | "boardLane" | "comment" | "closeReason";
    before: string | null;
    after: string | null;
  }[];
}
export interface Comment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface Attachment {
  id: string;
  name: string;
  url: string;
  mime: string;
  size: number;
}
export interface AuthStatus {
  setupRequired: boolean;
  user: User | null;
  oidc: { enabled: boolean; name: string };
}
export interface OidcSettings {
  enabled: boolean;
  name: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  allowSignup: boolean;
  callbackUrl: string;
}
export interface IssueDetail {
  issue: Issue;
  comments: Comment[];
}
export const LANES: BoardLane[] = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
];
