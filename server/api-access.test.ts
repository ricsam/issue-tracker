import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "./app";
import { openDatabase } from "./db";
import { authReturnTo } from "./api-access";
import { recoverAdmin } from "./recover-admin";

const owned: { dir: string; app?: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const { dir, app } of owned.splice(0)) { app?.close(); rmSync(dir, { recursive: true, force: true }); } });
const origin = "http://localhost:3000";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "threadline-api-access-"));
  const app = createApp({ dataDir: dir });
  owned.push({ dir, app });
  let n = 0;
  const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, ip?: string) => app.request(path, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }, { remoteAddress: ip ?? `test-${++n}` });
  const adminResponse = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" }, { Origin: origin });
  expect(adminResponse.status).toBe(200);
  const admin = (await adminResponse.json()).user;
  const cookie = adminResponse.headers.get("set-cookie")!.split(";")[0]!;
  const web = (path: string, method = "GET", body?: unknown, as = cookie) => req(path, method, body, { Cookie: as, Origin: origin });
  const key = async (scopes = ["read", "write"], as = cookie) => {
    const response = await web("/api/me/api-keys", "POST", { name: "Integration", scopes, expiresInDays: 30 }, as);
    expect(response.status).toBe(200); return response.json();
  };
  const bearer = (token: string, path: string, method = "GET", body?: unknown) => req(path, method, body, { Authorization: `Bearer ${token}` });
  const device = async () => {
    const response = await req("/api/auth/device/code", "POST", { name: "Threadline CLI", scopes: ["read", "write"] });
    expect(response.status).toBe(200); return response.json();
  };
  const member = async (name: string) => {
    const response = await web("/api/admin/users", "POST", { name, email: `${name}@example.com`, password: "long-password-123" });
    const user = (await response.json()).user;
    const login = await web("/api/auth/login", "POST", { email: user.email, password: "long-password-123" }, "");
    return { user, cookie: login.headers.get("set-cookie")!.split(";")[0]! };
  };
  return { app, dir, req, web, key, bearer, device, member, cookie, admin };
}

test("keys are hashed, scoped, private per user, expiring and revocable; no secret redisclosure", async () => {
  const { app, key, web, bearer, member } = await fixture();
  const { token, key: info } = await key(["read"]);
  expect(token).toMatch(/^tlk_[A-Za-z0-9_-]{43}$/);
  expect(info).toMatchObject({ name: "Integration", scopes: ["read"], source: "manual", lastUsedAt: null, revokedAt: null });
  const stored = app.db.query("SELECT * FROM api_keys").get() as any;
  expect(stored.hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(JSON.stringify(stored)).not.toContain(token);
  const result = await bearer(token, "/api/projects");
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await (await bearer(token, "/api/me")).json()).key.lastUsedAt).not.toBeNull();
  expect((await bearer(token, "/api/issues", "POST", { body: "Denied" })).status).toBe(403);
  const listed = await (await web("/api/me/api-keys")).json();
  expect(JSON.stringify(listed)).not.toContain(token);
  expect(JSON.stringify(listed)).not.toContain(stored.hash);
  const other = await member("other");
  expect((await (await web("/api/me/api-keys", "GET", undefined, other.cookie)).json()).keys).toEqual([]);
  expect((await web(`/api/me/api-keys/${info.id}`, "DELETE", undefined, other.cookie)).status).toBe(404);
  expect((await web(`/api/me/api-keys/${info.id}`, "DELETE")).status).toBe(200);
  expect((await web(`/api/me/api-keys/${info.id}`, "DELETE")).status).toBe(200);
  expect((await bearer(token, "/api/issues")).status).toBe(401);
  const expired = await key();
  app.db.query("UPDATE api_keys SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.key.id);
  expect((await bearer(expired.token, "/api/me")).status).toBe(401);
});

test("bearer auth cannot bypass origin/session boundaries, administer, mint or approve credentials", async () => {
  const { req, web, key, bearer, cookie } = await fixture();
  const { token } = await key();
  for (const [method, path, body] of [
    ["GET", "/api/admin/oidc"], ["POST", "/api/admin/users", {}], ["GET", "/api/auth/status"],
    ["GET", "/api/me/api-keys"], ["POST", "/api/me/api-keys", {}], ["DELETE", "/api/me/api-keys/x"],
    ["POST", "/api/auth/device/approve", {}], ["GET", "/api/auth/device/request?user_code=ABCD-EFGH"],
    ["POST", "/api/auth/device/code", {}], ["POST", "/api/auth/logout"],
  ] as [string, string, unknown?][]) expect((await bearer(token, path, method, body)).status).toBe(403);
  expect((await req("/api/issues", "POST", { body: "No CSRF bypass" }, { Cookie: cookie, Authorization: "Bearer invalid" })).status).toBe(401);
  expect((await req("/api/issues", "POST", { body: "No origin bypass" }, { Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
  expect((await req("/api/me/api-keys", "POST", { name: "X", scopes: ["read"], expiresInDays: 30 }, { Cookie: cookie })).status).toBe(403);
  expect((await req("/api/issues", "POST", { body: "No cookie bypass" }, { Cookie: cookie })).status).toBe(403);
  expect((await req(`/api/issues?api_key=${token}`)).status).toBe(401);
  expect((await web("/api/me/token", "DELETE")).status).toBe(400);
  expect((await bearer(token, "/api/me/token", "DELETE")).status).toBe(200);
  expect((await bearer(token, "/api/me")).status).toBe(401);
});

test("API key validation is strict and read-only keys may revoke themselves", async () => {
  const { web, key, bearer } = await fixture();
  for (const change of [{ scopes: [] }, { scopes: ["write"] }, { scopes: ["admin"] }, { scopes: ["read", "read"] }, { expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 1.5 }, { name: " " }, { name: "Name\u001b" }, { userId: "other" }])
    expect((await web("/api/me/api-keys", "POST", { name: "Good", scopes: ["read"], expiresInDays: 30, ...change })).status).toBe(400);
  const { token } = await key(["read"]);
  expect((await bearer(token, "/api/me/token", "DELETE")).status).toBe(200);
});

test("bearer operations reuse project/draft/history permissions and record the real actor", async () => {
  const { app, web, key, bearer, member } = await fixture();
  const owner = await member("owner"), other = await member("outsider");
  const { token } = await key(["read", "write"], owner.cookie);
  const { token: stranger } = await key(["read", "write"], other.cookie);
  const { project } = await (await web("/api/projects", "POST", { name: "Private", visibility: "private" }, owner.cookie)).json();
  const created = await bearer(token, `/api/projects/${project.slug}/issues`, "POST", { body: "# Integration\n\n#bug" });
  expect(created.status).toBe(200);
  const { issue } = await created.json();
  expect(issue.authorId).toBe(owner.user.id);
  expect((await bearer(token, `/api/issues/${issue.id}`, "PATCH", { title: "Updated", state: "closed" })).status).toBe(200);
  expect((await bearer(token, `/api/issues/${issue.id}/comments`, "POST", { body: "Comment" })).status).toBe(200);
  const history = await (await bearer(token, `/api/issues/${issue.id}/history`)).json();
  expect(history.history.every((h: any) => h.actorId === owner.user.id)).toBe(true);
  for (const path of [`/api/projects/${project.slug}`, `/api/issues/${issue.id}`, `/api/issues/${issue.id}/history`]) expect((await bearer(stranger, path)).status).toBe(404);
  expect((await (await bearer(stranger, "/api/issues")).json()).issues).toEqual([]);
  const draft = (await (await bearer(token, "/api/issues", "POST", { body: "Secret draft", state: "draft" })).json()).issue;
  const { token: adminToken } = await key();
  expect((await bearer(adminToken, `/api/issues/${draft.id}`)).status).toBe(404);
  await web(`/api/projects/${project.slug}`, "PATCH", { archived: true }, owner.cookie);
  expect((await bearer(token, `/api/issues/${issue.id}`, "PATCH", { body: "Denied" })).status).toBe(409);
  expect(app.db.query("SELECT COUNT(*) AS n FROM issue_history WHERE issueId=?").get(issue.id)).toEqual({ n: 3 });
});

test("existing tokens immediately lose access when project sharing is revoked", async () => {
  const { web, key, bearer, member } = await fixture();
  const owner = await member("sharingowner"), collaborator = await member("collaborator");
  const { project } = await (await web("/api/projects", "POST", { name: "Shared private", visibility: "private", sharedUserIds: [collaborator.user.id] }, owner.cookie)).json();
  const { issue } = await (await web(`/api/projects/${project.slug}/issues`, "POST", { body: "Accessible initially" }, owner.cookie)).json();
  const { token } = await key(["read", "write"], collaborator.cookie);
  expect((await bearer(token, `/api/issues/${issue.id}`)).status).toBe(200);
  expect((await web(`/api/projects/${project.slug}/access`, "PATCH", { sharedUserIds: [] }, owner.cookie)).status).toBe(200);
  expect((await bearer(token, `/api/issues/${issue.id}`)).status).toBe(404);
  expect((await bearer(token, `/api/issues/${issue.id}`, "PATCH", { body: "Denied after revocation" })).status).toBe(404);
  expect((await (await bearer(token, "/api/projects")).json()).projects).toEqual([]);
  expect((await (await bearer(token, "/api/issues")).json()).issues).toEqual([]);
});

test("browser device flow requires approval, hashes both codes, throttles polls, consumes once", async () => {
  const { app, req, web, bearer, device, admin } = await fixture();
  const flow = await device();
  expect(flow).toMatchObject({ verificationUri: `${origin}/cli/authorize`, expiresIn: 600, interval: 5 });
  expect(flow.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(JSON.stringify(app.db.query("SELECT * FROM device_authorizations").get())).not.toContain(flow.deviceCode);
  expect(JSON.stringify(app.db.query("SELECT * FROM device_authorizations").get())).not.toContain(flow.userCode.replace("-", ""));
  const poll = () => req("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode });
  expect(await (await poll()).json()).toEqual({ error: "authorization_pending" });
  expect(await (await poll()).json()).toEqual({ error: "slow_down" });
  expect((await req(`/api/auth/device/request?user_code=${flow.userCode}`)).status).toBe(401);
  const details = await web(`/api/auth/device/request?user_code=${flow.userCode}`);
  expect(details.status).toBe(200);
  expect(await details.json()).toMatchObject({ userCode: flow.userCode, name: "Threadline CLI", scopes: ["read", "write"], tokenExpiresInDays: 90 });
  expect((app.db.query("SELECT status FROM device_authorizations").get() as any).status).toBe("pending");
  expect((await req("/api/auth/device/approve", "POST", { userCode: flow.userCode, approve: true }, { Origin: origin })).status).toBe(401);
  expect((await web("/api/auth/device/approve", "POST", { userCode: flow.userCode.toLowerCase(), approve: true })).status).toBe(200);
  expect((await web("/api/auth/device/approve", "POST", { userCode: flow.userCode, approve: true })).status).toBe(409);
  app.db.query("UPDATE device_authorizations SET nextPollAt=0").run();
  const responses = await Promise.all([poll(), poll()]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  const result = await responses.find((r) => r.status === 200)!.json();
  expect(result.user.id).toBe(admin.id);
  expect(result.key).toMatchObject({ source: "cli", name: "Threadline CLI" });
  expect((await bearer(result.accessToken, "/api/projects")).status).toBe(200);
  expect(await (await poll()).json()).toEqual({ error: "expired_token" });
  expect(app.db.query("SELECT COUNT(*) AS n FROM api_keys").get()).toEqual({ n: 1 });
});

test("device denial, expiry, forged codes and malicious origins never mint credentials", async () => {
  const { app, req, web, device, cookie } = await fixture();
  const denied = await device();
  expect((await web("/api/auth/device/approve", "POST", { userCode: denied.userCode, approve: false })).status).toBe(200);
  expect(await (await req("/api/auth/device/token", "POST", { deviceCode: denied.deviceCode })).json()).toEqual({ error: "access_denied" });
  const expired = await device();
  app.db.query("UPDATE device_authorizations SET expires=0").run();
  expect((await web("/api/auth/device/approve", "POST", { userCode: expired.userCode, approve: true })).status).toBe(409);
  expect(await (await req("/api/auth/device/token", "POST", { deviceCode: expired.deviceCode })).json()).toEqual({ error: "expired_token" });
  expect(await (await req("/api/auth/device/token", "POST", { deviceCode: "A".repeat(43) })).json()).toEqual({ error: "expired_token" });
  const flow = await device();
  for (const headers of [{ Cookie: cookie }, { Cookie: cookie, Origin: "https://evil.example" }] as Record<string, string>[])
    expect((await req("/api/auth/device/approve", "POST", { userCode: flow.userCode, approve: true }, headers)).status).toBe(403);
  expect((await req("/api/auth/device/code", "POST", { name: "X", scopes: ["read"] }, { Origin: "https://evil.example" })).status).toBe(403);
  expect((await req("/api/auth/device/code", "POST", { name: "X", scopes: ["read"] }, { "Content-Type": "text/plain" })).status).toBe(400);
  expect(app.db.query("SELECT COUNT(*) AS n FROM api_keys").get()).toEqual({ n: 0 });
});

test("device guesses and starts are rate limited by server peer, not forwarded headers", async () => {
  const { req } = await fixture();
  for (let i = 0; i < 20; i++) expect((await req("/api/auth/device/code", "POST", { name: "CLI", scopes: ["read"] }, {}, "shared-peer")).status).toBe(200);
  expect((await req("/api/auth/device/code", "POST", { name: "CLI", scopes: ["read"] }, { "X-Forwarded-For": "another-peer" }, "shared-peer")).status).toBe(429);
  expect((await req("/api/auth/device/token", "POST", { deviceCode: "A".repeat(43) }, {}, "shared-peer")).status).toBe(400);
  for (let i = 0; i < 20; i++) expect((await req("/api/auth/device/request?user_code=ABCD-EFGH", "GET", undefined, {}, "guesser")).status).toBe(401);
  expect((await req("/api/auth/device/request?user_code=ABCD-EFGH", "GET", undefined, {}, "guesser")).status).toBe(429);
});

test("proxy peers do not share valid polling or approval budgets with starts/login", async () => {
  const { app, req, device, cookie, member } = await fixture();
  const peer = "reverse-proxy";
  for (let i = 0; i < 20; i++) expect((await req("/api/auth/device/code", "POST", { name: "CLI", scopes: ["read"] }, {}, peer)).status).toBe(200);
  expect((await req("/api/auth/login", "POST", { email: "missing@example.com", password: "long-password-123" }, { Origin: origin }, peer)).status).toBe(401);
  const flow = await device();
  // Simulate enough correctly spaced polls to exceed the former shared 120/minute cap.
  for (let i = 0; i < 121; i++) {
    app.db.query("UPDATE device_authorizations SET nextPollAt=0").run();
    expect(await (await req("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, {}, peer)).json()).toEqual({ error: "authorization_pending" });
  }
  for (let i = 0; i < 120; i++) expect((await req("/api/auth/device/token", "POST", { deviceCode: "A".repeat(43) }, {}, peer)).status).toBe(400);
  expect((await req("/api/auth/device/token", "POST", { deviceCode: "A".repeat(43) }, {}, peer)).status).toBe(429);
  app.db.query("UPDATE device_authorizations SET nextPollAt=0").run();
  expect(await (await req("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, {}, peer)).json()).toEqual({ error: "authorization_pending" });
  for (let i = 0; i < 20; i++) expect((await req(`/api/auth/device/request?user_code=${flow.userCode}`, "GET", undefined, { Cookie: cookie }, peer)).status).toBe(200);
  expect((await req(`/api/auth/device/request?user_code=${flow.userCode}`, "GET", undefined, { Cookie: cookie }, peer)).status).toBe(429);
  const other = await member("secondreviewer");
  expect((await req(`/api/auth/device/request?user_code=${flow.userCode}`, "GET", undefined, { Cookie: other.cookie }, peer)).status).toBe(200);
  expect((await req("/api/auth/device/code", "POST", { name: "X".repeat(5000), scopes: ["read"] })).status).toBe(413);
});

test("OIDC device return destinations are tightly allowlisted", () => {
  for (const value of ["/new", "/cli/authorize", "/cli/authorize?user_code=ABCD-EFGH"]) expect(authReturnTo(value)).toBe(value);
  for (const value of [undefined, "https://evil.example", "//evil.example", "/cli/authorize?next=https://evil.example", "/cli/authorize?user_code=ABCD-EFGH&next=/", "/cli/authorize/", "/cli/authorize?user_code=%0d%0a"]) expect(authReturnTo(value)).toBe("/");
});

test("migration 18 is additive, preserves content/sessions, and survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "threadline-auth-migration-"));
  owned.push({ dir });
  const path = join(dir, "app.sqlite");
  let db = openDatabase(path, 17);
  db.query("INSERT INTO users VALUES ('u','User','u@example.com','member','2026-01-01',NULL)").run();
  db.query("INSERT INTO sessions VALUES ('hash','u',9999999999999)").run();
  db.close();
  db = openDatabase(path);
  expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  expect(db.query("SELECT hash FROM sessions").get()).toEqual({ hash: "hash" });
  expect(db.query("SELECT COUNT(*) AS n FROM api_keys").get()).toEqual({ n: 0 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
  db = openDatabase(path);
  expect(db.query("SELECT COUNT(*) AS n FROM migrations WHERE version=18").get()).toEqual({ n: 1 });
  db.close();
});

test("administrator recovery invalidates API keys and approved pending device grants", async () => {
  const { app, dir, key, device, web, bearer } = await fixture();
  const { token } = await key();
  const flow = await device();
  await web("/api/auth/device/approve", "POST", { userCode: flow.userCode, approve: true });
  await recoverAdmin(join(dir, "app.sqlite"), "admin@example.com", "replacement-password-123");
  expect((await bearer(token, "/api/me")).status).toBe(401);
  expect(app.db.query("SELECT COUNT(*) AS n FROM device_authorizations").get()).toEqual({ n: 0 });
});
