import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { User } from "../shared/types";
import type { ApiKeyInfo, ApiScope, DeviceRequestInfo } from "../shared/api-access";

export type AppEnv = {
  Variables: { user: User; apiKey: ApiKeyInfo | undefined };
  Bindings: { remoteAddress?: string };
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scopesSchema = z.array(z.enum(["read", "write"])).min(1).max(2)
  .refine((scopes) => scopes.includes("read") && new Set(scopes).size === scopes.length);
const nameSchema = z.string().trim().min(1).max(100)
  .refine((name) => !/[\x00-\x1f\x7f-\x9f]/.test(name));
const keyFields = z.object({ name: nameSchema, scopes: scopesSchema, expiresInDays: z.number().int().min(1).max(365) }).strict();
const deviceFields = z.object({ name: nameSchema, scopes: scopesSchema }).strict();
const deviceCodeField = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const codeField = z.string().max(32).transform((code) => code.trim().toUpperCase().replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/));
const DAY = 86400000;
const DEVICE_TTL = 600;
const TOKEN_DAYS = 90;
const keyColumns = "id,name,prefix,scopes,source,createdAt,expiresAt,lastUsedAt,revokedAt";
type KeyRow = Omit<ApiKeyInfo, "scopes"> & { scopes: string };
const serializeKey = (row: KeyRow): ApiKeyInfo => ({ ...row, scopes: JSON.parse(row.scopes) });
type DeviceRow = { hash: string; name: string; scopes: string; expires: number; interval: number; nextPollAt: number; status: "pending" | "approved" | "denied"; userId: string | null };

/** Only these two JSON endpoints can be called without a session/Origin. */
export const publicDevicePaths = new Set(["/api/auth/device/code", "/api/auth/device/token"]);

/** Fail closed outside the data API: keys cannot administer users/SSO or mint credentials. */
export function apiKeyAllows(key: ApiKeyInfo, path: string, method: string) {
  if (path === "/api/me" && method === "GET") return true;
  if (path === "/api/me/token" && method === "DELETE") return true;
  const dataRoute = /^\/api\/(projects|issues|comments|uploads)(\/|$)/.test(path)
    || (path === "/api/users" && method === "GET")
    || /^\/api\/me\/(pinned-projects|favorite-projects)(\/|$)/.test(path);
  return dataRoute && key.scopes.includes(["GET", "HEAD"].includes(method) ? "read" : "write");
}

/** Exact internal destinations only; never accept a URL or arbitrary query string. */
export function authReturnTo(value: string | undefined) {
  if (value === "/new" || value === "/cli/authorize") return value;
  if (value && /^\/cli\/authorize\?user_code=[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(value)) return value;
  return "/";
}

export function apiAccess(db: Database) {
  const invalidPolls = new Map<string, { count: number; expires: number }>();
  function invalidPoll(peer: string) {
    const time = Date.now();
    for (const [key, value] of invalidPolls) if (value.expires <= time) invalidPolls.delete(key);
    if (!invalidPolls.has(peer)) {
      if (invalidPolls.size >= 10000) throw new HTTPException(429, { message: "Too many requests" });
      invalidPolls.set(peer, { count: 0, expires: time + 60000 });
    }
    if (++invalidPolls.get(peer)!.count > 120) throw new HTTPException(429, { message: "Too many requests" });
  }
  function keyInfo(id: string) {
    return serializeKey(db.query(`SELECT ${keyColumns} FROM api_keys WHERE id=?`).get(id) as KeyRow);
  }
  function issueKey(userId: string, name: string, scopes: ApiScope[], expiresInDays: number, source: ApiKeyInfo["source"]) {
    const now = new Date().toISOString();
    const { count } = db.query("SELECT COUNT(*) AS count FROM api_keys WHERE userId=? AND revokedAt IS NULL AND expiresAt>?").get(userId, now) as { count: number };
    if (count >= 100) throw new HTTPException(409, { message: "Revoke an existing API key before creating another (limit 100)" });
    const token = `tlk_${randomBytes(32).toString("base64url")}`;
    const id = crypto.randomUUID();
    db.query(`INSERT INTO api_keys (id,userId,hash,name,prefix,scopes,source,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, digest(token), name, token.slice(0, 12), JSON.stringify(scopes), source, now, new Date(Date.now() + expiresInDays * DAY).toISOString());
    return { token, key: keyInfo(id) };
  }
  function authenticate(authorization: string) {
    const match = /^Bearer (tlk_[A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) return null;
    const row = db.query(`SELECT userId,${keyColumns} FROM api_keys WHERE hash=? AND revokedAt IS NULL AND expiresAt>?`)
      .get(digest(match[1]!), new Date().toISOString()) as (KeyRow & { userId: string }) | null;
    if (!row) return null;
    const { userId, ...key } = row;
    return { userId, key: serializeKey(key) };
  }
  function touch(key: ApiKeyInfo) {
    // Keep usage useful without a SQLite write on every read request.
    if (!key.lastUsedAt || Date.parse(key.lastUsedAt) <= Date.now() - 60000)
      db.query("UPDATE api_keys SET lastUsedAt=? WHERE id=?").run(new Date().toISOString(), key.id);
  }
  function register(app: Hono<AppEnv>, baseUrl: string) {
    app.get("/api/me", (c) => c.json({ user: c.get("user"), key: c.get("apiKey") ?? null }));
    app.delete("/api/me/token", (c) => {
      const key = c.get("apiKey");
      if (!key) throw new HTTPException(400, { message: "Bearer token required" });
      db.query("UPDATE api_keys SET revokedAt=? WHERE id=?").run(new Date().toISOString(), key.id);
      return c.json({ ok: true });
    });
    app.get("/api/me/api-keys", (c) => c.json({ keys: (db.query(`SELECT ${keyColumns} FROM api_keys WHERE userId=? ORDER BY createdAt DESC,id`).all(c.get("user").id) as KeyRow[]).map(serializeKey) }));
    app.post("/api/me/api-keys", async (c) => {
      const input = keyFields.parse(await c.req.json().catch(() => null));
      return c.json(db.transaction(() => issueKey(c.get("user").id, input.name, input.scopes, input.expiresInDays, "manual")).immediate());
    });
    app.delete("/api/me/api-keys/:id", (c) => {
      const row = db.query("UPDATE api_keys SET revokedAt=COALESCE(revokedAt,?) WHERE id=? AND userId=? RETURNING id")
        .get(new Date().toISOString(), c.req.param("id"), c.get("user").id);
      if (!row) throw new HTTPException(404, { message: "API key not found" });
      return c.json({ ok: true });
    });
    app.post("/api/auth/device/code", async (c) => {
      const input = deviceFields.parse(await c.req.json().catch(() => null));
      const result = db.transaction(() => {
        db.query("DELETE FROM device_authorizations WHERE expires<=?").run(Date.now());
        if ((db.query("SELECT COUNT(*) AS count FROM device_authorizations").get() as { count: number }).count >= 10000)
          throw new HTTPException(429, { message: "Too many authorization requests" });
        const deviceCode = randomBytes(32).toString("base64url");
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code: string;
        do { code = Array.from(randomBytes(8), (byte) => alphabet[byte & 31]).join(""); }
        while (db.query("SELECT 1 FROM device_authorizations WHERE userCodeHash=?").get(digest(code)));
        db.query("INSERT INTO device_authorizations (hash,userCodeHash,name,scopes,expires) VALUES (?,?,?,?,?)")
          .run(digest(deviceCode), digest(code), input.name, JSON.stringify(input.scopes), Date.now() + DEVICE_TTL * 1000);
        return { deviceCode, userCode: `${code.slice(0, 4)}-${code.slice(4)}` };
      }).immediate();
      // Canonical deployment URL, never a client-supplied Host/redirect URI.
      const verificationUri = new URL("/cli/authorize", baseUrl).href;
      return c.json({ ...result, verificationUri, verificationUriComplete: `${verificationUri}?user_code=${result.userCode}`, expiresIn: DEVICE_TTL, interval: 5 });
    });
    app.get("/api/auth/device/request", (c) => {
      const code = codeField.parse(c.req.query("user_code"));
      const row = db.query("SELECT name,scopes,expires FROM device_authorizations WHERE userCodeHash=? AND status='pending' AND expires>?")
        .get(digest(code), Date.now()) as Pick<DeviceRow, "name" | "scopes" | "expires"> | null;
      if (!row) throw new HTTPException(404, { message: "Authorization request not found or expired" });
      return c.json({ userCode: `${code.slice(0, 4)}-${code.slice(4)}`, name: row.name, scopes: JSON.parse(row.scopes), expiresAt: new Date(row.expires).toISOString(), tokenExpiresInDays: TOKEN_DAYS } satisfies DeviceRequestInfo);
    });
    app.post("/api/auth/device/approve", async (c) => {
      const input = z.object({ userCode: codeField, approve: z.boolean() }).strict().parse(await c.req.json().catch(() => null));
      const row = db.query("UPDATE device_authorizations SET status=?,userId=? WHERE userCodeHash=? AND status='pending' AND expires>? RETURNING hash")
        .get(input.approve ? "approved" : "denied", c.get("user").id, digest(input.userCode), Date.now());
      if (!row) throw new HTTPException(409, { message: "Authorization request expired or already decided" });
      return c.json({ ok: true });
    });
    app.post("/api/auth/device/token", async (c) => {
      const parsed = z.object({ deviceCode: deviceCodeField }).strict().safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        invalidPoll(c.env?.remoteAddress ?? "unknown");
        throw parsed.error;
      }
      const input = parsed.data;
      const result = db.transaction(() => {
        const hash = digest(input.deviceCode);
        const row = db.query("SELECT * FROM device_authorizations WHERE hash=?").get(hash) as DeviceRow | null;
        if (!row || row.expires <= Date.now()) {
          db.query("DELETE FROM device_authorizations WHERE hash=?").run(hash);
          return { error: "expired_token" };
        }
        if (row.status === "denied") {
          db.query("DELETE FROM device_authorizations WHERE hash=?").run(hash);
          return { error: "access_denied" };
        }
        if (row.nextPollAt > Date.now()) {
          db.query("UPDATE device_authorizations SET interval=interval+5,nextPollAt=? WHERE hash=?").run(Date.now() + (row.interval + 5) * 1000, hash);
          return { error: "slow_down" };
        }
        if (row.status === "pending") {
          db.query("UPDATE device_authorizations SET nextPollAt=? WHERE hash=?").run(Date.now() + row.interval * 1000, hash);
          return { error: "authorization_pending" };
        }
        const { token, key } = issueKey(row.userId!, row.name, JSON.parse(row.scopes), TOKEN_DAYS, "cli");
        const user = db.query("SELECT id,name,email,role,createdAt FROM users WHERE id=?").get(row.userId!) as User;
        // Mint and consume in a single immediate transaction; replay never returns a token.
        db.query("DELETE FROM device_authorizations WHERE hash=?").run(hash);
        return { accessToken: token, tokenType: "Bearer", key, user };
      }).immediate();
      if ("error" in result && result.error === "expired_token") invalidPoll(c.env?.remoteAddress ?? "unknown");
      return "error" in result ? c.json(result, 400) : c.json(result);
    });
  }
  return { authenticate, touch, register };
}
