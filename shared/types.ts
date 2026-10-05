export type Role = "admin" | "member";
export type Lane = "todo" | "in_progress" | "done";
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
  issueCount: number;
  openCount: number;
}
export interface BoardCard {
  issueId: string;
  lane: Lane;
}
export interface BoardSettings {
  lanes: Lane[];
  cards: BoardCard[];
}
export interface Issue {
  id: string;
  number: number;
  projectId: string;
  title: string;
  body: string;
  labels: string[];
  assigneeId: string | null;
  authorId: string;
  createdAt: string;
  updatedAt: string;
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
export const LANES: { value: Lane; label: string }[] = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
];
