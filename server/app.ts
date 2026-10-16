import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  LANES,
  type BoardCard,
  type BoardSettings,
  type SubIssueProgress,
  type User,
  type Issue,
  type IssueRelationships,
  type Comment,
  type Project,
} from "../shared/types";
import {
  deriveIssueTitle,
  ISSUE_BODY_MAX_LENGTH,
  prependLegacyTitle,
  replaceLeadingTitle,
} from "../shared/issue-content";
import { appendIssueLabels, extractIssueLabels } from "../shared/labels";
import { isLabel } from "../shared/hashtag-matches";
import { moveLaneTo, orderedLanes } from "../shared/board";
import { openDatabase, syncIssueTaggedUsers, migrationWorkspaceOptions } from "./db";
import { appendIssueMentions, extractMentionUserIds } from "../shared/mentions";
import { withIssueHistory, recordIssueChange, recordHistory, readHistory, issueSnapshot } from "./history";
import { OidcService } from "./oidc";
import { securityHeaders } from "./security";
import { apiAccess, apiKeyAllows, authReturnTo, publicDevicePaths, type AppEnv } from "./api-access";
import { projectAccess, visibleProjectSql, visibleIssueSql, accessParams, issueAccessParams, workspaceIdFor } from "./project-access";
import { workspaceService, workspaceSlugField } from "./workspaces";
import { attachmentIds, canReadAttachment, retainAttachmentReferences } from "./attachments";
import { PluginService, PluginError, type PluginDefinition } from "./plugins";
import type { PluginEvent } from "../shared/plugins";
import { registerMcp } from "./mcp";

export interface AppOptions {
  dataDir?: string;
  baseUrl?: string;
  encryptionKey?: string;
  production?: boolean;
  allowInsecureOidc?: boolean;
  sessionTtlMs?: number;
  /** Initial v22 migration only; later starts never rename the legacy workspace. */
  migrationWorkspaceName?: string;
  migrationWorkspaceSlug?: string;
  /** Compiled definitions only; test fixtures may supply an isolated registry. */
  pluginDefinitions?: PluginDefinition[];
}
type Env = AppEnv;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const issueIdField = z.string().regex(/^[1-9][0-9]*$/).max(16)
  .refine((value) => Number.isSafeInteger(Number(value)));
const closeFields = z.object({
  reason: z.enum(["completed", "not_planned", "duplicate"]),
  duplicateOfId: issueIdField.optional(),
  comment: z.string().trim().min(1).max(100000).optional(),
}).strict();
const issueIdsField = z.array(issueIdField).min(1).max(1000)
  .refine((values) => new Set(values).size === values.length);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
const text = (max: number) => z.string().trim().min(1).max(max);
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(1024),
});
const account = credentials.extend({ name: text(100) }).strict();
const labelField = z.string().max(50).refine(isLabel);
const issueFields = z
  .object({
    title: text(300).optional(),
    body: z.string().max(ISSUE_BODY_MAX_LENGTH),
    labels: z.array(labelField).max(30).default([]),
  })
  .strict();
const issueUpdateFields = issueFields
  .extend({
    state: z.enum(["open", "closed", "draft"]),
    projectId: text(100).nullable(),
  })
  .partial();
// Metadata edits and lifecycle changes are separate actions; neither implicitly restores a project.
const projectUpdateFields = z.union([
  z.object({ archived: z.boolean() }).strict(),
  z.object({ name: text(100).optional(), description: z.string().max(10000).optional() })
    .strict().refine((input) => input.name !== undefined || input.description !== undefined),
]);
const sharedUsersField = z.array(z.string().uuid()).max(1000)
  .refine((ids) => new Set(ids).size === ids.length);
const projectAccessFields = z.object({
  visibility: z.enum(["public", "private"]).optional(),
  ownerId: z.string().uuid().optional(),
  sharedUserIds: sharedUsersField.optional(),
}).strict().refine((input) => Object.keys(input).length > 0);
const laneField = z.string().min(1).max(100);
const customLaneField = z.object({
  value: z.string().regex(/^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  label: text(60),
}).strict();
const boardFields = z
  .object({
    lanes: z
      .array(laneField)
      .min(1)
      .max(LANES.length + 30)
      .refine((values) => new Set(values).size === values.length),
    customLanes: z.array(customLaneField).max(30).optional(),
  })
  .strict();
const projectSql = `SELECT p.*, MAX(i.updatedAt) AS lastIssueUpdatedAt, COUNT(i.id) AS issueCount, (SELECT COUNT(*) FROM board_issues b JOIN issues bi ON bi.id=b.issueId WHERE b.projectId=p.id AND b.lane != 'done' AND bi.closedAt IS NULL AND bi.isDraft=0) AS openCount FROM projects p LEFT JOIN issues i ON i.projectId=p.id AND (i.isDraft=0 OR i.authorId=?)`;

export function createApp(options: AppOptions = {}) {
  const migrationWorkspace = migrationWorkspaceOptions({
    workspaceName: options.migrationWorkspaceName ?? process.env.MIGRATION_WORKSPACE_NAME,
    workspaceSlug: options.migrationWorkspaceSlug ?? process.env.MIGRATION_WORKSPACE_SLUG,
  });
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const baseUrl = new URL(
    options.baseUrl ?? process.env.BASE_URL ?? "http://localhost:3000",
  ).origin;
  if (production && !baseUrl.startsWith("https://"))
    throw new Error("Production BASE_URL must use HTTPS");
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const uploads = resolve(dataDir, "uploads");
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const encodedKey =
    options.encryptionKey ?? process.env.SETTINGS_ENCRYPTION_KEY;
  let key: Buffer;
  if (encodedKey) {
    key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== encodedKey)
      throw new Error(
        "SETTINGS_ENCRYPTION_KEY must be base64 encoded 32 bytes",
      );
  } else {
    if (production)
      throw new Error("SETTINGS_ENCRYPTION_KEY required in production");
    const keyPath = resolve(dataDir, ".settings-key");
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error("Invalid persistent settings key");
  }
  const db = openDatabase(resolve(dataDir, "app.sqlite"), 22, migrationWorkspace);
  // Legacy clients and saved uploads omit scope. Resolve by stable migration ID,
  // never by a literal slug which an operator may customize before first upgrade.
  const legacyWorkspaceSlug = () => (db.query("SELECT slug FROM workspaces WHERE id='default'").get() as { slug: string }).slug;
  const access = projectAccess(db);
  const workspaces = workspaceService(db);
  const tokens = apiAccess(db);
  const plugins = new PluginService(db, {
    plugins: options.pluginDefinitions,
    baseUrl,
    key,
    allowInsecureLocalhost: !production &&
      (options.allowInsecureOidc ?? process.env.ALLOW_INSECURE_OIDC === "true"),
  });
  // Hooks observe committed state, and neither synchronous nor asynchronous
  // plugin failures may turn a successful application mutation into an error.
  const emit = (event: PluginEvent) => {
    try {
      void Promise.resolve(plugins.emit(event)).catch(() => console.error("Plugin hook failed"));
    } catch {
      console.error("Plugin hook failed");
    }
  };
  const oidc = new OidcService(db, {
    baseUrl,
    key,
    allowInsecureLocalhost:
      !production &&
      (options.allowInsecureOidc ?? process.env.ALLOW_INSECURE_OIDC === "true"),
  });
  const app = new Hono<Env>();
  const cookieOptions = {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: baseUrl.startsWith("https:"),
    path: "/",
  };
  const ttl = options.sessionTtlMs ?? 7 * 86400000;
  const publicUser = (userId: string) =>
    db
      .query("SELECT id,name,email,role,createdAt FROM users WHERE id=?")
      .get(userId) as User | null;
  const session = (c: any, userId: string) => {
    const old = getCookie(c, "session");
    if (old) db.query("DELETE FROM sessions WHERE hash=?").run(hash(old));
    const token = randomBytes(32).toString("base64url");
    db.query("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    db.query("INSERT INTO sessions VALUES (?,?,?)").run(
      hash(token),
      userId,
      Date.now() + ttl,
    );
    setCookie(c, "session", token, {
      ...cookieOptions,
      maxAge: Math.floor(ttl / 1000),
    });
  };
  const json = async (c: any) => {
    try {
      return await c.req.json();
    } catch {
      return fail(400, "Invalid JSON");
    }
  };
  const requireAdmin = (c: any) => {
    if (c.get("user").role !== "admin") fail(403, "Administrator required");
  };
  const visibleDuplicate = (targetId: string, user: User) => !!db.query(
    `SELECT 1 FROM issues i WHERE i.id=? AND i.isDraft=0 AND ${visibleIssueSql}`,
  ).get(targetId, ...issueAccessParams(user));
  const issue = (issueId: string | number, user: User): Issue => {
    const row = db
      .query(
        "SELECT id,number,workspaceId,projectId,title,body,labels,authorId,closedAt,closedById,closeReason,duplicateOfId,isDraft,createdAt,updatedAt FROM issues WHERE id=?",
      )
      .get(issueId) as any;
    if (!row || row.workspaceId !== workspaceIdFor(user) || (row.isDraft && row.authorId !== user.id)) return fail(404, "Issue not found");
    access.requireRead(row.projectId, user, "Issue");
    const { isDraft, ...fields } = row;
    return {
      ...fields,
      id: String(row.id),
      duplicateOfId: row.duplicateOfId != null && visibleDuplicate(String(row.duplicateOfId), user) ? String(row.duplicateOfId) : null,
      number: row.number,
      workspaceSlug: user.workspaceSlug ?? legacyWorkspaceSlug(),
      access: access.level(row.projectId, user) === "full" ? "full" : "read",
      labels: JSON.parse(row.labels),
      taggedUserIds: (db.query("SELECT userId FROM issue_tagged_users WHERE issueId=? ORDER BY userId").all(issueId) as { userId: string }[]).map((r) => r.userId),
      state: isDraft ? "draft" : row.closedAt ? "closed" : "open",
      externalLinks: plugins.links(String(row.id)),
    };
  };
  const project = (slug: string, user: User) => {
    const row = db
      .query(`${projectSql} WHERE p.slug=? AND p.workspaceId=? GROUP BY p.id`)
      .get(user.id, slug, workspaceIdFor(user)) as Project | null;
    if (!row) return fail(404, "Project not found");
    access.requireRead(row.id, user);
    return access.serialize(row, user);
  };
  // Archived projects stay readable but reject content and board changes until restored.
  const activeProject = (slug: string, user: User) => {
    const p = project(slug, user);
    access.requireWrite(p.id, user);
    if (p.archivedAt) fail(409, "Project is archived");
    return p;
  };
  const requireActiveProjectId = (projectId: string, user: User) => {
    access.requireWrite(projectId, user);
    const p = db.query("SELECT archivedAt FROM projects WHERE id=?").get(projectId) as { archivedAt: string | null } | null;
    if (!p) return fail(404, "Project not found");
    if (p.archivedAt) fail(409, "Project is archived");
  };
  const activeIssue = (issueId: string, user: User) => {
    const i = issue(issueId, user);
    access.requireWrite(i.projectId, user, "Issue");
    if (i.projectId !== null) requireActiveProjectId(i.projectId, user);
    return i;
  };
  const relationships = (issueId: string, user: User): IssueRelationships => {
    const references = (direction: "parent" | "children") => {
      const join = direction === "parent" ? "r.parentId=i.id WHERE r.childId=?" : "r.childId=i.id WHERE r.parentId=?";
      const rows = db.query(`SELECT i.id,i.number,i.title,i.closedAt FROM issue_relationships r JOIN issues i ON ${join} AND i.isDraft=0 AND ${visibleIssueSql} ORDER BY i.id`)
        .all(issueId, ...issueAccessParams(user)) as { id: number; number: number; title: string; closedAt: string | null }[];
      return rows.map((row) => ({ id: String(row.id), number: row.number, title: row.title, state: row.closedAt ? "closed" as const : "open" as const }));
    };
    return { parent: references("parent")[0] ?? null, subIssues: references("children") };
  };
  const relationshipEndpoints = (parentId: string, childId: string, user: User) => {
    // Check both read permissions before revealing either endpoint's lifecycle state.
    const parent = issue(parentId, user), child = issue(childId, user);
    for (const endpoint of [parent, child]) access.requireWrite(endpoint.projectId, user, "Issue");
    if (parent.state === "draft" || child.state === "draft") fail(409, "Draft issues cannot have relationships");
    for (const endpoint of [parent, child]) if (endpoint.projectId !== null) requireActiveProjectId(endpoint.projectId, user);
  };
  // Called inside an immediate transaction, including create+link.
  const attachSubIssue = (parentId: string, childId: string, user: User) => {
    relationshipEndpoints(parentId, childId, user);
    if (parentId === childId) fail(409, "Invalid issue relationship");
    const old = db.query("SELECT parentId FROM issue_relationships WHERE childId=?").get(childId) as { parentId: number } | null;
    if (old) {
      if (String(old.parentId) === parentId) return;
      // Never disclose the old parent's ID, title, project or lifecycle.
      fail(409, "Issue relationship conflict");
    }
    const cycle = db.query(`WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT r.parentId FROM issue_relationships r JOIN ancestors a ON r.childId=a.id
    ) SELECT 1 FROM ancestors WHERE id=CAST(? AS INTEGER)`).get(Number(parentId), childId);
    if (cycle) fail(409, "Issue relationship conflict");
    db.query("INSERT INTO issue_relationships (childId,parentId) VALUES (?,?)").run(childId, parentId);
  };
  const board = (projectId: string): BoardSettings => {
    const row = db
      .query("SELECT lanes,customLanes,laneLabels FROM project_boards WHERE projectId=?")
      .get(projectId) as { lanes: string; customLanes: string; laneLabels: string } | null;
    const cards = db
      .query(
        "SELECT CAST(b.issueId AS TEXT) AS issueId,b.lane FROM board_issues b JOIN issues i ON i.id=b.issueId WHERE b.projectId=? AND i.isDraft=0 ORDER BY b.position,i.number",
      )
      .all(projectId) as BoardCard[];
    const laneLabels: Record<string, string> = JSON.parse(row?.laneLabels ?? "{}");
    return {
      ...(Object.keys(laneLabels).length ? { laneLabels } : {}),
      lanes: row ? JSON.parse(row.lanes) : LANES.map((s) => s.value),
      customLanes: row ? JSON.parse(row.customLanes) : [],
      cards,
    };
  };
  const requireBoardIssue = (issueId: string, projectId: string, user: User) => {
    const row = db.query("SELECT authorId,isDraft,closedAt FROM issues WHERE id=? AND projectId=?")
      .get(issueId, projectId) as { authorId: string; isDraft: number; closedAt: string | null } | null;
    if (!row) return fail(400, "Unknown project issue");
    if (row.isDraft) {
      // Match nonexistent/foreign IDs so board probes cannot identify a draft.
      if (row.authorId !== user.id) return fail(400, "Unknown project issue");
      return fail(409, "Publish draft issue before adding it to the board");
    }
    return row;
  };
  const nextBoardPosition = (projectId: string, lane: string) =>
    (db.query("SELECT COALESCE(MAX(position),0)+1 AS position FROM board_issues WHERE projectId=? AND lane=?")
      .get(projectId, lane) as { position: number }).position;
  const requireVisibleLane = (projectId: string, lane: string) => {
    const state = board(projectId);
    if (![...LANES, ...state.customLanes].some((definition) => definition.value === lane))
      fail(400, "Unknown lane");
    if (!state.lanes.includes(lane)) fail(400, "Destination lane is hidden");
  };
  const bodyLabels = (body: string) => {
    const labels = extractIssueLabels(body);
    if (labels.length > 30 || labels.some((label) => label.length > 50))
      fail(400, "Use at most 30 tags, each at most 50 characters");
    return labels;
  };
  const workspaceUser = (userId: string, user: User) => {
    if (!db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId=?").get(workspaceIdFor(user), userId))
      return fail(400, "Unknown workspace user");
    return publicUser(userId) ?? fail(400, "Unknown workspace user");
  };
  const validateMentions = (body: string, user: User) => {
    for (const userId of extractMentionUserIds(body)) workspaceUser(userId, user);
  };
  const saveSharedUsers = (projectId: string, userIds: string[]) => {
    const p = db.query("SELECT workspaceId FROM projects WHERE id=?").get(projectId) as { workspaceId: string };
    for (const userId of userIds) if (!db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId=?").get(p.workspaceId, userId))
      fail(400, "Unknown workspace user");
    db.query("DELETE FROM project_members WHERE projectId=?").run(projectId);
    for (const userId of userIds)
      db.query("INSERT INTO project_members (projectId,userId) VALUES (?,?)").run(projectId, userId);
  };
  const validateAttachments = (body: string, user: User) => {
    // A guessed URL must never grant access by being pasted into a public issue.
    for (const attachmentId of attachmentIds(body))
      if (!canReadAttachment(db, attachmentId, user)) fail(404, "Attachment not found");
  };
  const limits = new Map<string, { count: number; expires: number }>();
  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: "Invalid input" }, 400);
    if (err instanceof HTTPException)
      return c.json({ error: err.message }, err.status);
    if (err instanceof PluginError)
      return c.json({ error: err.message }, 400);
    if ((err as any).code?.startsWith("SQLITE_CONSTRAINT"))
      return c.json({ error: "Conflicting data" }, 409);
    return c.json({ error: "Request could not be completed" }, 500);
  });
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders))
      c.header(name, value);
    await next();
  });
  app.use("/api/auth/device/*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "Request too large" }, 413) }));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const path = c.req.path;
    const authorization = c.req.header("Authorization");
    const bearer = authorization !== undefined ? tokens.authenticate(authorization) : null;
    // An explicit invalid credential never falls back to a browser session.
    if (authorization !== undefined && !bearer)
      return c.json({ error: "Invalid or expired API key" }, 401);
    const publicDevice = publicDevicePaths.has(path) && c.req.method === "POST";
    const origin = c.req.header("Origin");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      (origin !== undefined ? origin !== baseUrl : !bearer && !publicDevice)
    ) return c.json({ error: "Invalid origin" }, 403);
    if (publicDevice && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return c.json({ error: "Content-Type must be application/json" }, 400);
    const token = getCookie(c, "session");
    const row = token && (db.query("SELECT userId FROM sessions WHERE hash=? AND expires>?")
      .get(hash(token), Date.now()) as { userId: string } | undefined);
    const user = bearer ? publicUser(bearer.userId) : row ? publicUser(row.userId) : null;
    if (user) c.set("user", user);
    if (
      path.startsWith("/api/auth/") &&
      path !== "/api/auth/status" &&
      path !== "/api/auth/logout" &&
      path !== "/api/auth/device/token"
    ) {
      // Starts cannot consume login's budget. Reviews are account-scoped;
      // valid polling is paced by the device credential inside its handler.
      // Never infer a client IP from untrusted forwarding headers.
      const peer = c.env?.remoteAddress ?? "unknown";
      const ip = path === "/api/auth/device/code" ? `device-start:${peer}`
        : path.startsWith("/api/auth/device/") ? `device-review:${user ? `user:${user.id}` : `peer:${peer}`}`
        : `auth:${peer}`;
      const time = Date.now();
      for (const [k, v] of limits) if (v.expires <= time) limits.delete(k);
      if (!limits.has(ip)) {
        if (limits.size >= 10000)
          return c.json({ error: "Too many requests" }, 429);
        limits.set(ip, { count: 0, expires: time + 60000 });
      }
      if (++limits.get(ip)!.count > 20)
        return c.json({ error: "Too many requests" }, 429);
    }
    if (bearer) {
      if (!user) return c.json({ error: "Invalid or expired API key" }, 401);
      if (!apiKeyAllows(bearer.key, path, c.req.method))
        return c.json({ error: "API key does not allow this operation" }, 403);
      c.set("apiKey", bearer.key);
      tokens.touch(bearer.key);
    }
    const isPublic = [
      "/api/auth/status",
      "/api/auth/setup",
      "/api/auth/login",
      "/api/auth/oidc/login",
      "/api/auth/oidc/callback",
    ].includes(path);
    if (!isPublic && !publicDevice && !user)
      return c.json({ error: "Authentication required" }, 401);
    if (user && !isPublic && !publicDevice) {
      workspaces.acceptInvitations(user);
      const contentRoute = /^\/api\/(projects|issues|comments|uploads|plugins|users)(\/|$)/.test(path)
        || /^\/api\/me\/(pinned-projects|favorite-projects)(\/|$)/.test(path);
      if (contentRoute) {
        // Native attachment images cannot send a custom request header.
        const attachmentWorkspace = c.req.method === "GET" && path.startsWith("/api/uploads/") ? c.req.query("workspace") : undefined;
        const slug = workspaceSlugField.parse(c.req.header("X-Workspace-Slug") ?? attachmentWorkspace ?? legacyWorkspaceSlug());
        const workspace = workspaces.get(slug, user);
        c.set("user", { ...user, workspaceId: workspace.id, workspaceSlug: workspace.slug });
      }
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 11 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  tokens.register(app, baseUrl);
  workspaces.register(app);
  registerMcp(app, { tokens, baseUrl, publicUser });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => {
    db.query("SELECT 1").get();
    return c.json({ ok: true });
  });
  app.get("/api/auth/status", (c) =>
    c.json({
      setupRequired: !db.query("SELECT 1 FROM users LIMIT 1").get(),
      user: c.get("user") ?? null,
      oidc: { enabled: oidc.settings().enabled, name: oidc.settings().name },
    }),
  );
  app.post("/api/auth/setup", async (c) => {
    const input = account.parse(await json(c));
    if (db.query("SELECT 1 FROM users LIMIT 1").get())
      return fail(409, "Setup already completed");
    const password = await Bun.password.hash(input.password, {
      algorithm: "argon2id",
    });
    const userId = id();
    db.transaction(() => {
      if (db.query("SELECT 1 FROM users LIMIT 1").get())
        fail(409, "Setup already completed");
      db.query("INSERT INTO users VALUES (?,?,?,?,?,?)").run(
        userId,
        input.name,
        input.email,
        "admin",
        now(),
        password,
      );
    }).immediate();
    session(c, userId);
    return c.json({ user: publicUser(userId)! });
  });
  const dummyPassword = Bun.password.hashSync(randomBytes(32).toString("hex"), {
    algorithm: "argon2id",
  });
  app.post("/api/auth/login", async (c) => {
    const input = credentials.parse(await json(c));
    const row = db
      .query("SELECT id,password FROM users WHERE email=?")
      .get(input.email) as { id: string; password: string | null } | null;
    const valid = await Bun.password.verify(
      input.password,
      row?.password ?? dummyPassword,
    );
    if (!valid || !row?.password) return fail(401, "Invalid email or password");
    session(c, row.id);
    return c.json({ user: publicUser(row.id)! });
  });
  app.post("/api/auth/logout", (c) => {
    const token = getCookie(c, "session");
    if (token) db.query("DELETE FROM sessions WHERE hash=?").run(hash(token));
    deleteCookie(c, "session", cookieOptions);
    return c.json({ ok: true });
  });
  app.get("/api/auth/oidc/login", async (c) => {
    try {
      if (!oidc.settings().enabled) return fail(400, "OIDC is disabled");
      const flow = await oidc.login();
      const token = randomBytes(32).toString("base64url");
      db.query("DELETE FROM oidc_flows WHERE expires<=?").run(Date.now());
      db.query("INSERT INTO oidc_flows VALUES (?,?,?,?,?)").run(
        hash(token),
        flow.state,
        flow.verifier,
        flow.nonce,
        Date.now() + 600000,
      );
      setCookie(c, "oidc_flow", token, { ...cookieOptions, maxAge: 600 });
      // An exact allowlist, never a user-controlled URL. Reset on every new flow.
      setCookie(c, "oidc_return", authReturnTo(c.req.query("returnTo")), { ...cookieOptions, maxAge: 600 });
      return c.redirect(flow.url);
    } catch {
      return c.json({ error: "Unable to start OIDC login" }, 400);
    }
  });
  app.get("/api/auth/oidc/callback", async (c) => {
    const token = getCookie(c, "oidc_flow");
    const returnTo = authReturnTo(getCookie(c, "oidc_return"));
    deleteCookie(c, "oidc_flow", cookieOptions);
    deleteCookie(c, "oidc_return", cookieOptions);
    const flow =
      token &&
      (db
        .query(
          "DELETE FROM oidc_flows WHERE hash=? AND expires>? RETURNING state,verifier,nonce",
        )
        .get(hash(token), Date.now()) as any);
    if (!flow) return fail(400, "Invalid OIDC session");
    try {
      const callbackUrl = new URL("/api/auth/oidc/callback", baseUrl);
      callbackUrl.search = new URL(c.req.url).search;
      const identity = await oidc.callback(callbackUrl, flow);
      const userId = db
        .transaction(() => {
          const existing = db
            .query("SELECT userId FROM identities WHERE issuer=? AND subject=?")
            .get(identity.issuer, identity.subject) as {
            userId: string;
          } | null;
          if (existing) {
            const current = publicUser(existing.userId)!;
            // Existing identity never silently links a different email account.
            if (current.email.toLowerCase() === identity.email.toLowerCase())
              db.query("INSERT INTO verified_account_emails VALUES (?,?) ON CONFLICT(userId) DO UPDATE SET email=excluded.email").run(current.id, identity.email);
            else db.query("DELETE FROM verified_account_emails WHERE userId=?").run(current.id);
            return existing.userId;
          }
          if (
            !oidc.settings().allowSignup ||
            !db.query("SELECT 1 FROM users LIMIT 1").get()
          )
            fail(403, "Signup disabled");
          // Email never links identities. A collision is rejected rather than taking over an account.
          const uid = id();
          db.query("INSERT INTO users VALUES (?,?,?,?,?,NULL)").run(
            uid,
            identity.name,
            identity.email,
            "member",
            now(),
          );
          db.query("INSERT INTO identities VALUES (?,?,?)").run(
            identity.issuer,
            identity.subject,
            uid,
          );
          db.query("INSERT INTO verified_account_emails VALUES (?,?)").run(uid, identity.email);
          return uid;
        })
        .immediate();
      session(c, userId);
      return c.redirect(returnTo);
    } catch {
      return c.json({ error: "OIDC login failed" }, 400);
    }
  });
  app.get("/api/users", (c) => {
    const user = c.get("user");
    const member = user.role === "admin" || db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId=?").get(workspaceIdFor(user), user.id);
    if (!member) return fail(404, "Workspace not found");
    return c.json({ users: db.query(`SELECT u.id,u.name,u.email,u.role,u.createdAt FROM users u
      JOIN workspace_members m ON m.userId=u.id WHERE m.workspaceId=? ORDER BY u.name`).all(workspaceIdFor(user)) as User[] });
  });
  app.get("/api/admin/users", (c) => {
    requireAdmin(c);
    return c.json({ users: db.query("SELECT id,name,email,role,createdAt FROM users ORDER BY name").all() as User[] });
  });
  app.post("/api/admin/users", async (c) => {
    requireAdmin(c);
    const input = account.parse(await json(c));
    const password = await Bun.password.hash(input.password, {
      algorithm: "argon2id",
    });
    const uid = id();
    db.query("INSERT INTO users VALUES (?,?,?,?,?,?)").run(
      uid,
      input.name,
      input.email,
      "member",
      now(),
      password,
    );
    return c.json({ user: publicUser(uid)! });
  });
  app.get("/api/admin/oidc", (c) => {
    requireAdmin(c);
    return c.json(oidc.settings());
  });
  app.put("/api/admin/oidc", async (c) => {
    requireAdmin(c);
    const input = await json(c);
    try {
      return c.json(oidc.update(input));
    } catch {
      return c.json({ error: "Invalid OIDC settings" }, 400);
    }
  });
  app.get("/api/admin/plugins", (c) => {
    requireAdmin(c);
    return c.json({ plugins: plugins.adminSettings() });
  });
  app.put("/api/admin/plugins/:id", async (c) => {
    requireAdmin(c);
    return c.json({ plugin: await plugins.update(c.req.param("id"), await json(c)) });
  });
  app.get("/api/plugins", (c) => c.json({ plugins: plugins.publicSettings(c.get("user")), baseUrl }));
  app.get("/api/issues/:id/external-links", (c) => {
    const canonical = issueIdField.safeParse(c.req.param("id"));
    if (!canonical.success) return fail(404, "Issue not found");
    // Exactly the detail route's draft/project checks, including no admin
    // override for another person's draft. Never authorize by link ownership.
    const current = issue(canonical.data, c.get("user"));
    return c.json({ links: current.externalLinks ?? [] });
  });
  app.get("/api/projects", (c) =>
    c.json({
      projects: db
        .query(`${projectSql} WHERE ${visibleProjectSql} GROUP BY p.id ORDER BY p.createdAt,p.id`)
        .all(c.get("user").id, ...accessParams(c.get("user"))).map((row) => access.serialize(row as Project, c.get("user"))),
    }),
  );
  app.post("/api/projects", async (c) => {
    const input = z
      .object({
        name: text(100),
        slug: workspaceSlugField.optional(),
        description: z.string().max(10000).default(""),
        visibility: z.enum(["public", "private"]).default("public"),
        sharedUserIds: sharedUsersField.default([]),
      })
      .strict()
      .parse(await json(c));
    const slug = input.slug ?? (
      (input.name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "project") +
      "-" +
      randomBytes(4).toString("hex"));
    db.transaction(() => {
      access.requireWrite(null, c.get("user"));
      const projectId = id();
      db.query(
        "INSERT INTO projects (id,slug,name,description,createdAt,visibility,ownerId,workspaceId) VALUES (?,?,?,?,?,?,?,?)",
      ).run(projectId, slug, input.name, input.description, now(), input.visibility, c.get("user").id, workspaceIdFor(c.get("user")));
      saveSharedUsers(projectId, input.sharedUserIds);
    }).immediate();
    return c.json({ project: project(slug, c.get("user")) });
  });
  app.get("/api/projects/:slug", (c) =>
    c.json({ project: project(c.req.param("slug"), c.get("user")) }),
  );
  app.patch("/api/projects/:slug/access", async (c) => {
    const input = projectAccessFields.parse(await json(c));
    const updated = db.transaction(() => {
      const p = project(c.req.param("slug"), c.get("user"));
      access.requireManage(p, c.get("user"));
      if (input.ownerId !== undefined) {
        workspaceUser(input.ownerId, c.get("user"));
        db.query("UPDATE projects SET ownerId=? WHERE id=?").run(input.ownerId, p.id);
      }
      if (input.visibility !== undefined)
        db.query("UPDATE projects SET visibility=? WHERE id=?").run(input.visibility, p.id);
      if (input.sharedUserIds !== undefined) saveSharedUsers(p.id, input.sharedUserIds);
      // A transfer may revoke the caller's access, but still return the committed
      // settings for this authorized operation. Subsequent reads use the new ACL.
      const row = db.query(`${projectSql} WHERE p.id=? GROUP BY p.id`).get(c.get("user").id, p.id) as Project;
      return access.serialize(row, c.get("user"));
    }).immediate();
    return c.json({ project: updated });
  });
  app.patch("/api/projects/:slug", async (c) => {
    const p = project(c.req.param("slug"), c.get("user"));
    const input = projectUpdateFields.parse(await json(c));
    db.transaction(() => {
      access.requireWrite(p.id, c.get("user"));
      if ("archived" in input) {
        // Conditional writes keep repeated archive requests idempotent.
        if (input.archived)
          db.query(
            "UPDATE projects SET archivedAt=?,archivedById=? WHERE id=? AND archivedAt IS NULL",
          ).run(now(), c.get("user").id, p.id);
        else
          db.query(
            "UPDATE projects SET archivedAt=NULL,archivedById=NULL WHERE id=?",
          ).run(p.id);
      } else {
        activeProject(p.slug, c.get("user"));
        // Update only supplied fields. Slug, identity, creation history and children stay unchanged.
        if (input.name !== undefined) db.query("UPDATE projects SET name=? WHERE id=?").run(input.name, p.id);
        if (input.description !== undefined) db.query("UPDATE projects SET description=? WHERE id=?").run(input.description, p.id);
      }
    }).immediate();
    return c.json({ project: project(p.slug, c.get("user")) });
  });
  app.get("/api/projects/:slug/board", (c) =>
    c.json({ board: board(project(c.req.param("slug"), c.get("user")).id) }),
  );
  app.get("/api/projects/:slug/board/sub-issue-progress", (c) => {
    const user = c.get("user"), p = project(c.req.param("slug"), user);
    // Both endpoints use current issue permissions. No lane filter: hidden cards
    // remain board members, and children need not belong to any board/project.
    const rows = db.query(`SELECT CAST(b.issueId AS TEXT) AS issueId,
      COUNT(*) AS total, SUM(CASE WHEN i.closedAt IS NOT NULL THEN 1 ELSE 0 END) AS closed
      FROM board_issues b
      JOIN issue_relationships r ON r.parentId=b.issueId
      JOIN issues i ON i.id=r.childId
      WHERE b.projectId=? AND i.isDraft=0 AND ${visibleIssueSql}
        AND EXISTS (SELECT 1 FROM issues i WHERE i.id=b.issueId AND i.isDraft=0 AND ${visibleIssueSql})
      GROUP BY b.issueId`).all(p.id, ...issueAccessParams(user), ...issueAccessParams(user)) as
      (SubIssueProgress & { issueId: string })[];
    const progress: Record<string, SubIssueProgress> = Object.fromEntries(
      rows.map(({ issueId, total, closed }) => [issueId, { total, closed }]),
    );
    return c.json({ progress });
  });
  app.patch("/api/projects/:slug/board", async (c) => {
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const input = boardFields.parse(await json(c));
    db.transaction(() => {
      activeProject(p.slug, c.get("user"));
      const state = board(p.id);
      const customLanes = [...state.customLanes];
      const seenIds = new Set<string>();
      for (const definition of input.customLanes ?? []) {
        const label = definition.label.toLowerCase();
        if (seenIds.has(definition.value))
          fail(400, "Duplicate custom lane");
        seenIds.add(definition.value);
        const existing = customLanes.find((lane) => lane.value === definition.value);
        if (existing) {
          if (existing.label !== definition.label) fail(400, "Custom lanes cannot be renamed");
          continue;
        }
        if (orderedLanes([...LANES, ...customLanes].map((lane) => lane.value), customLanes, state.laneLabels)
          .some((lane) => lane.label.toLowerCase() === label))
          fail(400, "Duplicate lane label");
        customLanes.push(definition);
      }
      if (customLanes.length > 30) fail(400, "Too many custom lanes");
      const definitions = [...LANES, ...customLanes];
      if (input.lanes.some((value) => !definitions.some((lane) => lane.value === value)))
        fail(400, "Unknown lane");
      // The submitted order is the board's display order.
      db.query(
        `INSERT INTO project_boards (projectId,lanes,customLanes) VALUES (?,?,?) ON CONFLICT(projectId) DO UPDATE SET lanes=excluded.lanes,customLanes=excluded.customLanes`,
      ).run(p.id, JSON.stringify(input.lanes), JSON.stringify(customLanes));
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.patch("/api/projects/:slug/board/lanes/:lane", async (c) => {
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const lane = c.req.param("lane");
    const { index, label } = z
      .object({ index: z.number().int().min(0).optional(), label: text(60).optional() })
      .strict()
      .refine((input) => input.index !== undefined || input.label !== undefined)
      .parse(await json(c));
    db.transaction(() => {
      activeProject(p.slug, c.get("user"));
      // Move within the current state so concurrent visibility changes are kept;
      // positions past the end place the lane last.
      const state = board(p.id);
      if (![...LANES, ...state.customLanes].some((definition) => definition.value === lane))
        fail(404, "Lane not found");
      if (!state.lanes.includes(lane)) fail(400, "Lane is hidden");
      const laneLabels = { ...state.laneLabels };
      if (label !== undefined) {
        const definitions = [...LANES, ...state.customLanes];
        if (orderedLanes(definitions.map((definition) => definition.value), state.customLanes, laneLabels)
          .some((definition) => definition.value !== lane && definition.label.toLowerCase() === label.toLowerCase()))
          fail(400, "Duplicate lane label");
        if (definitions.find((definition) => definition.value === lane)!.label === label) delete laneLabels[lane];
        else laneLabels[lane] = label;
      }
      db.query(
        `INSERT INTO project_boards (projectId,lanes,customLanes,laneLabels) VALUES (?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET lanes=excluded.lanes,laneLabels=excluded.laneLabels`,
      ).run(
        p.id,
        JSON.stringify(index === undefined ? state.lanes : moveLaneTo(state.lanes, lane, index)),
        JSON.stringify(state.customLanes),
        JSON.stringify(laneLabels),
      );
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.delete("/api/projects/:slug/board/lanes/:lane", (c) => {
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const lane = c.req.param("lane");
    db.transaction(() => {
      activeProject(p.slug, c.get("user"));
      const state = board(p.id);
      if (![...LANES, ...state.customLanes].some((definition) => definition.value === lane))
        fail(404, "Lane not found");
      // Repeated removal is a no-op; definitions, overrides and cards are retained.
      if (!state.lanes.includes(lane)) return;
      if (state.lanes.length === 1) fail(400, "Cannot remove the last lane");
      db.query(`INSERT INTO project_boards (projectId,lanes,customLanes) VALUES (?,?,?)
        ON CONFLICT(projectId) DO UPDATE SET lanes=excluded.lanes`)
        .run(p.id, JSON.stringify(state.lanes.filter((value) => value !== lane)), JSON.stringify(state.customLanes));
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  const historyTransaction = <T>(c: Context<Env>, ids: string[], mutate: () => T) => ({
    immediate: () => {
      const before = new Map([...new Set(ids)].map((id) => [id, issueSnapshot(db, id)]));
      const actorId = c.get("user").id;
      const result = withIssueHistory(db, actorId, ids, mutate);
      // withIssueHistory has committed. Failed writes and no-ops emit nothing.
      for (const [issueId, previous] of before) {
        const current = issueSnapshot(db, issueId);
        if (!current || !previous) continue;
        if (previous.body !== current.body || previous.state !== current.state || previous.projectId !== current.projectId)
          emit({ type: "issue.updated", issueId, actorId });
        if (previous.state !== current.state && current.state === "closed")
          emit({ type: "issue.closed", issueId, actorId });
        if (previous.state === "closed" && current.state === "open")
          emit({ type: "issue.reopened", issueId, actorId });
        if (previous.lane !== current.lane || (previous.lane !== null && previous.projectId !== current.projectId))
          emit({ type: "card.moved", issueId, actorId });
      }
      return result;
    },
  });
  const pinnedProjects = (user: User, legacy = false) => ({ projectIds: (db.query(`SELECT f.projectId FROM favorite_projects f JOIN projects p ON p.id=f.projectId WHERE f.userId=? AND ${visibleProjectSql} ORDER BY ${legacy ? "f.projectId" : "f.position,f.projectId"}`)
    .all(user.id, ...accessParams(user)) as { projectId: string }[]).map((row) => row.projectId) });
  for (const resource of ["favorite-projects", "pinned-projects"] as const) {
    const legacy = resource === "favorite-projects";
    app.get(`/api/me/${resource}`, (c) => c.json(pinnedProjects(c.get("user"), legacy)));
    for (const method of ["put", "delete"] as const) app[method](`/api/me/${resource}/:projectId`, async (c) => {
      const projectId = c.req.param("projectId");
      const user = c.get("user");
      let beforeProjectId: string | null | undefined;
      if (method === "put" && !legacy) {
        const raw = await c.req.text();
        let body: unknown = {};
        if (raw.length) {
          try { body = JSON.parse(raw); } catch { fail(400, "Invalid JSON"); }
        }
        beforeProjectId = z.object({ beforeProjectId: z.string().min(1).max(200).nullable().optional() }).strict().parse(body).beforeProjectId;
      }
      const result = db.transaction(() => {
        access.requireRead(projectId, user);
        if (method === "delete") {
          db.query("DELETE FROM favorite_projects WHERE userId=? AND projectId=?").run(user.id, projectId);
        } else {
          // Include inaccessible/archived pins in the stored order; never discard
          // preferences merely because access is temporarily revoked.
          const ids = (db.query("SELECT projectId FROM favorite_projects WHERE userId=? ORDER BY position,projectId")
            .all(user.id) as { projectId: string }[]).map((row) => row.projectId);
          if (beforeProjectId !== undefined || !ids.includes(projectId)) {
            if (beforeProjectId != null) {
              if (beforeProjectId === projectId) fail(400, "Cannot move a project before itself");
              access.requireRead(beforeProjectId, user);
              if (!ids.includes(beforeProjectId)) fail(400, "Target project is not pinned");
            }
            const ordered = ids.filter((id) => id !== projectId);
            ordered.splice(beforeProjectId == null ? ordered.length : ordered.indexOf(beforeProjectId), 0, projectId);
            const save = db.query("INSERT INTO favorite_projects (userId,projectId,position) VALUES (?,?,?) ON CONFLICT(userId,projectId) DO UPDATE SET position=excluded.position");
            for (const [position, id] of ordered.entries()) save.run(user.id, id, position);
          }
        }
        return pinnedProjects(user, legacy);
      }).immediate();
      return c.json(result);
    });
  }
  const tagIssues = async (c: Context<Env>) => {
    const ids = z.array(z.string().uuid()).min(1).max(1000)
      .refine((values) => new Set(values).size === values.length);
    const input = z.object({ issueIds: issueIdsField, userIds: ids }).strict().parse(await json(c));
    const issues = historyTransaction(c, input.issueIds, () => {
      const slug = c.req.param("slug");
      const p = slug ? activeProject(slug, c.get("user")) : null;
      const users = input.userIds.map((userId) => workspaceUser(userId, c.get("user")));
      return input.issueIds.map((issueId) => {
        const current = activeIssue(issueId, c.get("user"));
        if (p && current.projectId !== p.id) fail(400, "Unknown project issue");
        const body = appendIssueMentions(current.body, current.title, users);
        if (body.length > ISSUE_BODY_MAX_LENGTH) fail(400, "Tagged issue exceeds body length limit");
        if (body !== current.body) {
          db.query("UPDATE issues SET body=?,labels=?,updatedAt=? WHERE id=?").run(body, JSON.stringify(bodyLabels(body)), now(), issueId);
          syncIssueTaggedUsers(db, issueId);
        }
        return issue(issueId, c.get("user"));
      });
    }).immediate();
    return c.json({ issues });
  };
  app.post("/api/projects/:slug/issues/tag", tagIssues);
  app.post("/api/issues/tagged-users", tagIssues);
  const labelIssues = async (c: Context<Env>) => {
    const input = z.object({
      issueIds: issueIdsField,
      labels: z.array(labelField).min(1).max(30),
    }).strict().parse(await json(c));
    const issues = historyTransaction(c, input.issueIds, () => {
      const slug = c.req.param("slug");
      const p = slug ? activeProject(slug, c.get("user")) : null;
      return input.issueIds.map((issueId) => {
        const current = activeIssue(issueId, c.get("user"));
        if (p && current.projectId !== p.id) fail(400, "Unknown project issue");
        const body = appendIssueLabels(current.body, current.title, input.labels);
        if (body.length > ISSUE_BODY_MAX_LENGTH) fail(400, "Labeled issue exceeds body length limit");
        if (body !== current.body) {
          db.query("UPDATE issues SET body=?,labels=?,updatedAt=? WHERE id=?").run(body, JSON.stringify(bodyLabels(body)), now(), issueId);
          syncIssueTaggedUsers(db, issueId);
        }
        return issue(issueId, c.get("user"));
      });
    }).immediate();
    return c.json({ issues });
  };
  app.post("/api/projects/:slug/issues/labels", labelIssues);
  app.post("/api/issues/labels", labelIssues);
  app.post("/api/projects/:slug/board/issues", async (c) => {
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const input = z
      .object({
        issueIds: issueIdsField,
        lane: laneField,
      })
      .strict()
      .parse(await json(c));
    historyTransaction(c, input.issueIds, () => {
      activeProject(p.slug, c.get("user"));
      requireVisibleLane(p.id, input.lane);
      for (const issueId of input.issueIds)
        requireBoardIssue(issueId, p.id, c.get("user"));
      for (const issueId of input.issueIds) {
        if (
          db
            .query(
              "SELECT issueId FROM board_issues WHERE projectId=? AND issueId=?",
            )
            .get(p.id, issueId)
        )
          fail(409, "Issue already on board");
        db.query("INSERT INTO board_issues (projectId,issueId,lane,position) VALUES (?,?,?,?)").run(
          p.id,
          issueId,
          input.lane,
          nextBoardPosition(p.id, input.lane),
        );
      }
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.post("/api/projects/:slug/board/issues/reorder", async (c) => {
    const input = z.object({
      issueIds: issueIdsField,
      lane: laneField,
      beforeIssueId: issueIdField.nullable(),
    }).strict().parse(await json(c));
    const result = historyTransaction(c, input.issueIds, () => {
      const p = activeProject(c.req.param("slug"), c.get("user"));
      requireVisibleLane(p.id, input.lane);
      const current = board(p.id).cards;
      const selected = new Set(input.issueIds);
      if (input.issueIds.some((id) => !current.some((card) => card.issueId === id)))
        fail(400, "Unknown board member");
      if (input.beforeIssueId !== null && (selected.has(input.beforeIssueId) ||
        !current.some((card) => card.issueId === input.beforeIssueId && card.lane === input.lane)))
        fail(400, "Invalid destination anchor");
      const destination = current.filter((card) => card.lane === input.lane && !selected.has(card.issueId)).map((card) => card.issueId);
      const index = input.beforeIssueId === null ? destination.length : destination.indexOf(input.beforeIssueId);
      destination.splice(index, 0, ...input.issueIds);
      const previous = current.filter((card) => card.lane === input.lane).map((card) => card.issueId);
      if (previous.length !== destination.length || previous.some((id, i) => id !== destination[i])) {
        // Only the destination needs renumbering. Source gaps retain the exact
        // relative order of all remaining cards, including hidden/filter-excluded ones.
        for (const [position, issueId] of destination.entries())
          db.query("UPDATE board_issues SET lane=?,position=? WHERE projectId=? AND issueId=? AND (lane!=? OR position!=?)")
            .run(input.lane, position + 1, p.id, issueId, input.lane, position + 1);
      }
      return board(p.id);
    }).immediate();
    return c.json({ board: result });
  });
  app.put("/api/projects/:slug/board/issues", async (c) => {
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const input = z.object({
      issueIds: issueIdsField,
      lane: laneField,
    }).strict().parse(await json(c));
    historyTransaction(c, input.issueIds, () => {
      activeProject(p.slug, c.get("user"));
      requireVisibleLane(p.id, input.lane);
      for (const issueId of input.issueIds) {
        const current = requireBoardIssue(issueId, p.id, c.get("user"));
        const member = db.query("SELECT issueId FROM board_issues WHERE projectId=? AND issueId=?")
          .get(p.id, issueId);
        if (current.closedAt && !member)
          fail(409, "Reopen closed issue before adding it to the board");
      }
      for (const issueId of input.issueIds)
        db.query(`INSERT INTO board_issues (projectId,issueId,lane,position) VALUES (?,?,?,?)
          ON CONFLICT(projectId,issueId) DO UPDATE SET lane=excluded.lane,position=excluded.position
          WHERE board_issues.lane != excluded.lane`).run(p.id, issueId, input.lane, nextBoardPosition(p.id, input.lane));
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.patch("/api/projects/:slug/board/issues/:id", async (c) => {
    issueIdField.parse(c.req.param("id"));
    const p = activeProject(c.req.param("slug"), c.get("user"));
    const { lane } = z
      .object({ lane: laneField })
      .strict()
      .parse(await json(c));
    historyTransaction(c, [c.req.param("id")], () => {
      activeProject(p.slug, c.get("user"));
      issue(c.req.param("id"), c.get("user"));
      if (
        !db
          .query(
            "SELECT issueId FROM board_issues WHERE projectId=? AND issueId=?",
          )
          .get(p.id, c.req.param("id"))
      )
        fail(404, "Board member not found");
      requireVisibleLane(p.id, lane);
      db.query(
        "UPDATE board_issues SET lane=?,position=? WHERE projectId=? AND issueId=? AND lane!=?",
      ).run(lane, nextBoardPosition(p.id, lane), p.id, c.req.param("id"), lane);
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.delete("/api/projects/:slug/board/issues/:id", (c) => {
    issueIdField.parse(c.req.param("id"));
    const p = activeProject(c.req.param("slug"), c.get("user"));
    historyTransaction(c, [c.req.param("id")], () => {
      issue(c.req.param("id"), c.get("user"));
      const result = db.query("DELETE FROM board_issues WHERE projectId=? AND issueId=?").run(p.id, c.req.param("id"));
      if (!result.changes) fail(404, "Board member not found");
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  app.get("/api/projects/:slug/issues", (c) => {
    const p = project(c.req.param("slug"), c.get("user"));
    const rows = db
      .query(`SELECT i.id FROM issues i WHERE i.projectId=? AND ${visibleIssueSql} ORDER BY i.number`)
      .all(p.id, ...issueAccessParams(c.get("user"))) as { id: string }[];
    return c.json({ issues: rows.map((r) => issue(r.id, c.get("user"))) });
  });
  app.get("/api/issues", (c) => {
    // Return board metadata with the list so clients need no request per project.
    const rows = db.query(`SELECT i.id,i.projectId FROM issues i WHERE ${visibleIssueSql} ORDER BY i.createdAt,i.id`)
      .all(...issueAccessParams(c.get("user"))) as { id: string; projectId: string | null }[];
    const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
    return c.json({ issues: rows.map((r) => issue(r.id, c.get("user"))), boards: Object.fromEntries(projectIds.map((id) => [id, board(id)])) });
  });
  const createIssue = async (c: Context<Env>) => {
    const slug = c.req.param("slug");
    const fields = issueFields.extend({ lane: laneField.nullable().optional(), state: z.enum(["open", "draft"]).default("open"), parentId: issueIdField.optional() });
    const input = (slug ? fields : fields.extend({ projectId: text(100).nullable().optional() }))
      .parse(await json(c)) as z.infer<typeof fields> & { projectId?: string | null };
    const originalBody = input.title === undefined ? input.body : prependLegacyTitle(input.title, input.body);
    const body = appendIssueLabels(originalBody, deriveIssueTitle(originalBody), input.labels);
    if (!body.trim() || body.length > ISSUE_BODY_MAX_LENGTH)
      fail(400, "Invalid issue body");
    const time = now();
    const result = db.transaction(() => {
      const projectId = slug ? activeProject(slug, c.get("user")).id : input.projectId ?? null;
      access.requireWrite(projectId, c.get("user"), "Issue");
      if (projectId !== null) requireActiveProjectId(projectId, c.get("user"));
      if (input.lane != null) {
        if (input.state === "draft") return fail(400, "Draft issues cannot be placed on a board");
        if (projectId === null) return fail(400, "Lane requires a project");
        requireVisibleLane(projectId, input.lane);
      }
      validateMentions(body, c.get("user"));
      validateAttachments(body, c.get("user"));
      const workspaceId = workspaceIdFor(c.get("user"));
      // Counter increments and issue insertion share the same immediate transaction.
      const { number } = db.query("UPDATE workspaces SET nextIssueNumber=MAX(nextIssueNumber,(SELECT COALESCE(MAX(number),0)+1 FROM issues WHERE workspaceId=?))+1 WHERE id=? RETURNING nextIssueNumber-1 AS number")
        .get(workspaceId, workspaceId) as { number: number };
      const inserted = db.query(
        "INSERT INTO issues (workspaceId,number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt,isDraft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      ).get(
        workspaceId,
        number,
        projectId,
        deriveIssueTitle(originalBody),
        body,
        "backlog", // Archived legacy columns; not active issue state.
        "none",
        JSON.stringify(bodyLabels(body)),
        c.get("user").id,
        time,
        time,
        input.state === "draft" ? 1 : 0,
      ) as { id: number };
      const uid = String(inserted.id);
      if (input.parentId !== undefined) attachSubIssue(input.parentId, uid, c.get("user"));
      syncIssueTaggedUsers(db, uid);
      retainAttachmentReferences(db, uid, [body]);
      if (input.lane != null && projectId !== null) {
        db.query("INSERT INTO board_issues (projectId,issueId,lane,position) VALUES (?,?,?,?)")
          .run(projectId, uid, input.lane, nextBoardPosition(projectId, input.lane));
        recordIssueChange(db, uid, c.get("user").id, null);
        return { issue: issue(uid, c.get("user")), board: board(projectId) };
      }
      recordIssueChange(db, uid, c.get("user").id, null);
      return { issue: issue(uid, c.get("user")) };
    }).immediate();
    emit({ type: "issue.created", issueId: result.issue.id, actorId: c.get("user").id });
    if (input.lane != null) emit({ type: "card.moved", issueId: result.issue.id, actorId: c.get("user").id });
    return c.json(result);
  };
  app.post("/api/projects/:slug/issues", createIssue);
  app.post("/api/issues", createIssue);
  app.get("/api/issues/references", (c) => {
    const query = z.string().trim().max(300).parse(c.req.query("q") ?? "");
    const numeric = query.replace(/^!/, "");
    const exactId = issueIdField.safeParse(numeric);
    const rows = exactId.success
      ? db.query(`SELECT i.id,i.number,i.title,i.closedAt,i.isDraft FROM issues i WHERE i.number=? AND ${visibleIssueSql} LIMIT 20`)
        .all(exactId.data, ...issueAccessParams(c.get("user")))
      : db.query(`SELECT i.id,i.number,i.title,i.closedAt,i.isDraft FROM issues i WHERE instr(lower(i.title),lower(?))>0 AND ${visibleIssueSql} ORDER BY i.number DESC LIMIT 20`)
        .all(query, ...issueAccessParams(c.get("user")));
    return c.json({ issues: (rows as { id: number; number: number; title: string; closedAt: string | null; isDraft: number }[]).map((row) => ({
      id: String(row.id), number: row.number, title: row.title, state: row.isDraft ? "draft" as const : row.closedAt ? "closed" as const : "open" as const,
    })) });
  });
  app.get("/api/issues/:id/relationships", (c) => {
    const canonical = issueIdField.safeParse(c.req.param("id"));
    if (!canonical.success) return fail(404, "Issue not found");
    issue(canonical.data, c.get("user"));
    return c.json(relationships(canonical.data, c.get("user")));
  });
  app.post("/api/issues/:id/sub-issues", async (c) => {
    const parentId = issueIdField.parse(c.req.param("id"));
    const { issueId: childId } = z.object({ issueId: issueIdField }).strict().parse(await json(c));
    const result = db.transaction(() => {
      attachSubIssue(parentId, childId, c.get("user"));
      return relationships(parentId, c.get("user"));
    }).immediate();
    return c.json(result);
  });
  app.delete("/api/issues/:id/sub-issues/:childId", (c) => {
    const parentId = issueIdField.parse(c.req.param("id")), childId = issueIdField.parse(c.req.param("childId"));
    const result = db.transaction(() => {
      relationshipEndpoints(parentId, childId, c.get("user"));
      db.query("DELETE FROM issue_relationships WHERE parentId=? AND childId=?").run(parentId, childId);
      return relationships(parentId, c.get("user"));
    }).immediate();
    return c.json(result);
  });
  app.get("/api/issues/:id/history", (c) => {
    const canonical = issueIdField.safeParse(c.req.param("id"));
    if (!canonical.success) return fail(404, "Issue not found");
    const current = issue(canonical.data, c.get("user"));
    const before = c.req.query("before");
    const limit = c.req.query("limit");
    const cursor = before === undefined ? null : Number(issueIdField.parse(before));
    const size = limit === undefined ? 50 : Number(issueIdField.parse(limit));
    if (size > 100) fail(400, "Limit must be between 1 and 100");
    return c.json(readHistory(db, current.id, cursor, size));
  });
  app.get("/api/issues/by-number/:number", (c) => {
    const number = issueIdField.safeParse(c.req.param("number"));
    if (!number.success) return fail(404, "Issue not found");
    const row = db.query("SELECT id FROM issues WHERE workspaceId=? AND number=?").get(workspaceIdFor(c.get("user")), number.data) as { id: number } | null;
    if (!row) return fail(404, "Issue not found");
    const current = issue(row.id, c.get("user"));
    return c.json({ issue: current, comments: db.query("SELECT *,CAST(issueId AS TEXT) AS issueId FROM comments WHERE issueId=? ORDER BY createdAt,id").all(current.id) as Comment[] });
  });
  app.get("/api/issues/:id", (c) => {
    const canonical = issueIdField.safeParse(c.req.param("id"));
    if (!canonical.success) return fail(404, "Issue not found");
    const current = issue(canonical.data, c.get("user"));
    return c.json({
      issue: current,
      comments: db.query("SELECT *,CAST(issueId AS TEXT) AS issueId FROM comments WHERE issueId=? ORDER BY createdAt,id").all(current.id) as Comment[],
    });
  });
  app.post("/api/issues/:id/close", async (c) => {
    const issueId = issueIdField.parse(c.req.param("id"));
    const input = closeFields.parse(await json(c));
    const user = c.get("user");
    let comment: Comment | undefined;
    historyTransaction(c, [issueId], () => {
      const current = activeIssue(issueId, user);
      if (current.state !== "open") fail(409, current.state === "draft" ? "Publish draft issue before closing it" : "Issue is already closed");
      if (input.reason === "duplicate") {
        if (!input.duplicateOfId || input.duplicateOfId === issueId) return fail(400, "A distinct duplicate target is required");
        if (!visibleDuplicate(input.duplicateOfId, user)) fail(404, "Duplicate target not found");
      } else if (input.duplicateOfId !== undefined) fail(400, "Duplicate target requires duplicate reason");
      const time = now();
      db.query("UPDATE issues SET closedAt=?,closedById=?,closeReason=?,duplicateOfId=?,updatedAt=? WHERE id=?")
        .run(time, user.id, input.reason, input.duplicateOfId ?? null, time, issueId);
      if (input.comment !== undefined) {
        validateMentions(input.comment, user);
        validateAttachments(input.comment, user);
        comment = { id: id(), issueId, authorId: user.id, body: input.comment, createdAt: time, updatedAt: time };
        db.query("INSERT INTO comments VALUES (?,?,?,?,?,?)")
          .run(comment.id, issueId, user.id, comment.body, time, time);
        syncIssueTaggedUsers(db, issueId);
        retainAttachmentReferences(db, issueId, [comment.body]);
        recordHistory(db, issueId, user.id, "commented", [{ field: "comment", before: null, after: comment.body }]);
      }
    }).immediate();
    if (comment) emit({ type: "comment.created", issueId, actorId: user.id, commentId: comment.id });
    return c.json({ issue: issue(issueId, user), ...(comment ? { comment } : {}) });
  });
  app.patch("/api/issues/:id", async (c) => {
    const issueId = issueIdField.parse(c.req.param("id"));
    const raw = await json(c);
    const current = activeIssue(issueId, c.get("user"));
    const parsed = issueUpdateFields.parse(raw);
    const input = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => Object.hasOwn(raw, key)),
    ) as z.infer<typeof issueUpdateFields>;
    if (!Object.keys(input).length) return fail(400, "No changes");
    const originalBody =
      input.title === undefined
        ? (input.body ?? current.body)
        : input.body === undefined
          ? replaceLeadingTitle(input.title, current.body)
          : prependLegacyTitle(input.title, input.body);
    const body = appendIssueLabels(originalBody, current.title, input.labels ?? []);
    if (input.body !== undefined || input.title !== undefined || input.labels !== undefined) {
      if (!body.trim() || body.length > ISSUE_BODY_MAX_LENGTH)
        fail(400, "Invalid issue body");
    }
    const merged = {
      ...current,
      ...input,
      body,
      labels: body !== current.body ? bodyLabels(body) : current.labels,
      title:
        input.body !== undefined || input.title !== undefined
          ? deriveIssueTitle(originalBody)
          : current.title,
      updatedAt: now(),
    };
    historyTransaction(c, [current.id], () => {
      const latest = activeIssue(current.id, c.get("user"));
      if (input.state === "draft" && latest.state !== "draft") fail(409, "Published issues cannot become drafts");
      if (input.state === "closed" && latest.state === "draft") fail(409, "Publish draft issue before closing it");
      if (input.projectId !== undefined) access.requireWrite(input.projectId, c.get("user"), "Project");
      if (input.projectId != null) requireActiveProjectId(input.projectId, c.get("user"));
      if (body !== current.body) validateAttachments(body, c.get("user"));
      if (input.projectId !== undefined && input.projectId !== current.projectId) {
        db.query("DELETE FROM board_issues WHERE issueId=?").run(current.id);
        db.query("UPDATE issues SET projectId=? WHERE id=?").run(input.projectId, current.id);
      }
      if (input.body !== undefined) validateMentions(body, c.get("user"));
      else if (input.title !== undefined) validateMentions(input.title, c.get("user"));
      db.query(
        "UPDATE issues SET title=?,body=?,labels=?,updatedAt=? WHERE id=?",
      ).run(
        merged.title,
        merged.body,
        JSON.stringify(merged.labels),
        merged.updatedAt,
        current.id,
      );
      // Closing an already closed issue keeps its original close time and closer.
      if (input.state === "closed")
        db.query(
          "UPDATE issues SET closedAt=?,closedById=?,closeReason='completed',duplicateOfId=NULL WHERE id=? AND closedAt IS NULL",
        ).run(merged.updatedAt, c.get("user").id, current.id);
      else if (input.state === "open")
        db.query(
          "UPDATE issues SET isDraft=0,closedAt=NULL,closedById=NULL,closeReason=NULL,duplicateOfId=NULL WHERE id=?",
        ).run(current.id);
      if (body !== current.body)
        syncIssueTaggedUsers(db, current.id);
      retainAttachmentReferences(db, current.id, [current.body, body]);
    }).immediate();
    return c.json({ issue: issue(current.id, c.get("user")) });
  });
  app.post("/api/issues/:id/comments", async (c) => {
    const i = activeIssue(issueIdField.parse(c.req.param("id")), c.get("user"));
    const { body } = z
      .object({ body: text(100000) })
      .strict()
      .parse(await json(c));
    const uid = id(),
      time = now();
    db.transaction(() => {
      activeIssue(i.id, c.get("user"));
      validateMentions(body, c.get("user"));
      validateAttachments(body, c.get("user"));
      db.query("INSERT INTO comments VALUES (?,?,?,?,?,?)").run(
        uid, i.id, c.get("user").id, body, time, time,
      );
      syncIssueTaggedUsers(db, i.id);
      retainAttachmentReferences(db, i.id, [body]);
      recordHistory(db, i.id, c.get("user").id, "commented", [{ field: "comment", before: null, after: body }]);
    }).immediate();
    emit({ type: "comment.created", issueId: i.id, actorId: c.get("user").id, commentId: uid });
    return c.json({
      comment: db
        .query("SELECT * FROM comments WHERE id=?")
        .get(uid) as Comment,
      issue: issue(i.id, c.get("user")),
    });
  });
  const ownedComment = (c: any) => {
    const row = db
      .query("SELECT * FROM comments WHERE id=?")
      .get(c.req.param("id")) as Comment | null;
    if (!row) return fail(404, "Comment not found");
    issue(row.issueId, c.get("user"));
    if (row.authorId !== c.get("user").id && !access.canManageWorkspace(c.get("user")))
      fail(403, "Not permitted");
    return row;
  };
  app.patch("/api/comments/:id", async (c) => {
    const row = ownedComment(c);
    activeIssue(row.issueId, c.get("user"));
    const { body } = z
      .object({ body: text(100000) })
      .strict()
      .parse(await json(c));
    db.transaction(() => {
      activeIssue(row.issueId, c.get("user"));
      validateMentions(body, c.get("user"));
      validateAttachments(body, c.get("user"));
      const previous = ownedComment(c);
      retainAttachmentReferences(db, row.issueId, [previous.body, body]);
      db.query("UPDATE comments SET body=?,updatedAt=? WHERE id=?").run(body, now(), row.id);
      if (previous.body !== body) recordHistory(db, row.issueId, c.get("user").id, "comment_edited", [{ field: "comment", before: previous.body, after: body }]);
      syncIssueTaggedUsers(db, row.issueId);
    }).immediate();
    return c.json({
      comment: db
        .query("SELECT * FROM comments WHERE id=?")
        .get(row.id) as Comment,
      issue: issue(row.issueId, c.get("user")),
    });
  });
  app.delete("/api/comments/:id", (c) => {
    const row = ownedComment(c);
    activeIssue(row.issueId, c.get("user"));
    db.transaction(() => {
      activeIssue(row.issueId, c.get("user"));
      const previous = ownedComment(c);
      retainAttachmentReferences(db, row.issueId, [previous.body]);
      db.query("DELETE FROM comments WHERE id=?").run(row.id);
      recordHistory(db, row.issueId, c.get("user").id, "comment_deleted", [{ field: "comment", before: previous.body, after: null }]);
      syncIssueTaggedUsers(db, row.issueId);
    }).immediate();
    return c.json({ ok: true, issue: issue(row.issueId, c.get("user")) });
  });
  app.post("/api/uploads", async (c) => {
    if (!access.canWriteAny(c.get("user"))) fail(403, "Full access required");
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(400, "Invalid multipart form");
    }
    const file = form.get("file");
    if (!(file instanceof File)) return fail(400, "File required");
    if (file.size > 10 * 1024 * 1024) return fail(413, "File too large");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffRaster(bytes);
    const uid = id();
    const name =
      file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200) || "file";
    const path = resolve(uploads, uid);
    try {
      await Bun.write(path, bytes);
      db.query("INSERT INTO attachments (id,name,mime,size,uploaderId,workspaceId) VALUES (?,?,?,?,?,?)").run(
        uid,
        name,
        mime,
        file.size,
        c.get("user").id,
        workspaceIdFor(c.get("user")),
      );
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
    return c.json({
      attachment: {
        id: uid,
        name,
        url: `/api/uploads/${uid}/${encodeURIComponent(name)}${c.get("user").workspaceSlug !== "default" ? `?workspace=${c.get("user").workspaceSlug}` : ""}`,
        mime,
        size: file.size,
      },
    });
  });
  app.get("/api/uploads/:id/:name", async (c) => {
    const row = db
      .query("SELECT * FROM attachments WHERE id=?")
      .get(c.req.param("id")) as {
      id: string;
      name: string;
      mime: string;
      size: number;
    } | null;
    if (!row || row.name !== c.req.param("name") || !canReadAttachment(db, row.id, c.get("user")))
      return fail(404, "Attachment not found");
    const file = Bun.file(resolve(uploads, row.id));
    if (!(await file.exists())) return fail(404, "Attachment not found");
    c.header("Content-Type", row.mime);
    c.header(
      "Content-Disposition",
      `${row.mime.startsWith("image/") ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g, "%27")}`,
    );
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return c.body(await file.arrayBuffer());
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return Object.assign(app, { db, plugins, close: () => { void plugins.close(); db.close(); }, baseUrl });
}

export function sniffRaster(b: Uint8Array): string {
  if (
    b.length >= 24 &&
    Buffer.from(b.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ) &&
    Buffer.from(b.subarray(12, 16)).toString() === "IHDR"
  )
    return "image/png";
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (
    b.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(Buffer.from(b.subarray(0, 6)).toString())
  )
    return "image/gif";
  if (
    b.length >= 16 &&
    Buffer.from(b.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(b.subarray(8, 12)).toString() === "WEBP"
  )
    return "image/webp";
  return "application/octet-stream";
}
