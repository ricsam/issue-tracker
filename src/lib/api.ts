export const AUTH_EXPIRED_EVENT = "threadline:auth-expired";
const publicAuthPaths = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

let workspaceSlug: string | null = null;
let workspaceGeneration = 0;
let workspaceController = new AbortController();
export function setApiWorkspace(slug: string | null) {
  if (workspaceSlug === slug) return;
  workspaceController.abort();
  workspaceController = new AbortController();
  workspaceSlug = slug;
  workspaceGeneration++;
}
export const getApiWorkspace = () => workspaceSlug;
let pendingWrites = 0;
export const hasPendingWorkspaceWrites = () => pendingWrites > 0;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const scoped = /^\/api\/(?:projects|issues|comments|users|uploads|plugins|me\/(?:pinned-projects|favorite-projects))(?:[/?#]|$)/.test(path);
  const generation = workspaceGeneration;
  const headers = new Headers(init.headers);
  const targetWorkspace = headers.get("X-Workspace-Slug") || workspaceSlug;
  if (scoped && !targetWorkspace) throw new Error("Select an accessible workspace first.");
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (scoped) headers.set("X-Workspace-Slug", targetWorkspace!);
  const signal = scoped ? (init.signal ? AbortSignal.any([init.signal, workspaceController.signal]) : workspaceController.signal) : init.signal;
  const writing = scoped && !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  if (writing) pendingWrites++;
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, signal, credentials: "same-origin" });
  } catch (cause) {
    if (writing && signal?.aborted) throw new Error("Workspace changed while saving. The result is uncertain; check the original workspace before retrying.");
    throw cause;
  } finally { if (writing) pendingWrites--; }
  const pathname = path.split(/[?#]/)[0] ?? path;
  if (
    response.status === 401 &&
    pathname.startsWith("/api/") &&
    !publicAuthPaths.has(pathname)
  ) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  const data = await response.json().catch(() => null);
  if (scoped && generation !== workspaceGeneration) throw new DOMException("Workspace changed", "AbortError");
  if (!response.ok)
    throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}
export const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
