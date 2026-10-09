export type Role = "admin" | "member";
export type Lane = string;
export type IssueState = "open" | "closed";
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
}
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  /** Archived projects are hidden from navigation and read-only until restored. */
  archivedAt: string | null;
  archivedById: string | null;
  issueCount: number;
  openCount: number;
}
export interface BoardCard {
  issueId: string;
  lane: Lane;
}
export interface BoardSettings {
  lanes: Lane[];
  customLanes: BoardLane[];
  /** Array order defines the saved card order within each lane. */
  cards: BoardCard[];
}
export type IssueReference = Pick<Issue, "id" | "number" | "title" | "state">;
export interface Issue {
  /** Global sequential integer key serialized as a canonical decimal string. */
  id: string;
  /** Numeric alias of id for display and sorting; unique across all projects. */
  number: number;
  projectId: string | null;
  title: string;
  body: string;
  labels: string[];
  taggedUserIds: string[];
  authorId: string;
  /** Derived from closedAt; closing never changes board membership or lanes. */
  state: IssueState;
  closedAt: string | null;
  closedById: string | null;
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
    field: "body" | "state" | "project" | "boardLane" | "comment";
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
