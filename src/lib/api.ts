export const AUTH_EXPIRED_EVENT = "threadline:auth-expired";
const publicAuthPaths = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const pathname = path.split(/[?#]/)[0] ?? path;
  if (
    response.status === 401 &&
    pathname.startsWith("/api/") &&
    !publicAuthPaths.has(pathname)
  ) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}
export const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
