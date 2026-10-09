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
  type User,
  type Issue,
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
import { moveLaneTo } from "../shared/board";
import { openDatabase, syncIssueTaggedUsers } from "./db";
import { appendIssueMentions, extractMentionUserIds } from "../shared/mentions";
import { OidcService } from "./oidc";
import { securityHeaders } from "./security";

export interface AppOptions {
  dataDir?: string;
  baseUrl?: string;
  encryptionKey?: string;
  production?: boolean;
  allowInsecureOidc?: boolean;
  sessionTtlMs?: number;
}
type Env = { Variables: { user: User }; Bindings: { remoteAddress?: string } };
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const issueIdField = z.string().regex(/^[1-9][0-9]*$/).max(16)
  .refine((value) => Number.isSafeInteger(Number(value)));
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
const issueFields = z
  .object({
    title: text(300).optional(),
    body: z.string().max(ISSUE_BODY_MAX_LENGTH),
    labels: z.array(text(50)).max(30).default([]),
  })
  .strict();
const issueUpdateFields = issueFields
  .extend({
    state: z.enum(["open", "closed"]),
  })
  .partial();
// Metadata edits and lifecycle changes are separate actions; neither implicitly restores a project.
const projectUpdateFields = z.union([
  z.object({ archived: z.boolean() }).strict(),
  z.object({ name: text(100).optional(), description: z.string().max(10000).optional() })
    .strict().refine((input) => input.name !== undefined || input.description !== undefined),
]);
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
const projectSql = `SELECT p.*, COUNT(i.id) AS issueCount, (SELECT COUNT(*) FROM board_issues b JOIN issues bi ON bi.id=b.issueId WHERE b.projectId=p.id AND b.lane != 'done' AND bi.closedAt IS NULL) AS openCount FROM projects p LEFT JOIN issues i ON i.projectId=p.id`;

export function createApp(options: AppOptions = {}) {
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
  const db = openDatabase(resolve(dataDir, "app.sqlite"));
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
  const issue = (issueId: string | number): Issue => {
    const row = db
      .query(
        "SELECT id,number,projectId,title,body,labels,authorId,closedAt,closedById,createdAt,updatedAt FROM issues WHERE id=?",
      )
      .get(issueId) as any;
    if (!row) return fail(404, "Issue not found");
    return {
      ...row,
      id: String(row.id),
      number: Number(row.id),
      labels: JSON.parse(row.labels),
      taggedUserIds: (db.query("SELECT userId FROM issue_tagged_users WHERE issueId=? ORDER BY userId").all(issueId) as { userId: string }[]).map((r) => r.userId),
      state: row.closedAt ? "closed" : "open",
    };
  };
  const project = (slug: string) => {
    const row = db
      .query(`${projectSql} WHERE p.slug=? GROUP BY p.id`)
      .get(slug) as Project | null;
    return row ?? fail(404, "Project not found");
  };
  // Archived projects stay readable but reject content and board changes until restored.
  const activeProject = (slug: string) => {
    const p = project(slug);
    if (p.archivedAt) fail(409, "Project is archived");
    return p;
  };
  const activeIssue = (issueId: string) => {
    const i = issue(issueId);
    if (i.projectId === null) return i;
    const { archivedAt } = db
      .query("SELECT archivedAt FROM projects WHERE id=?")
      .get(i.projectId) as { archivedAt: string | null };
    if (archivedAt) fail(409, "Project is archived");
    return i;
  };
  const board = (projectId: string): BoardSettings => {
    const row = db
      .query("SELECT lanes,customLanes FROM project_boards WHERE projectId=?")
      .get(projectId) as { lanes: string; customLanes: string } | null;
    const cards = db
      .query(
        "SELECT CAST(b.issueId AS TEXT) AS issueId,b.lane FROM board_issues b JOIN issues i ON i.id=b.issueId WHERE b.projectId=? ORDER BY b.position,i.number",
      )
      .all(projectId) as BoardCard[];
    return {
      lanes: row ? JSON.parse(row.lanes) : LANES.map((s) => s.value),
      customLanes: row ? JSON.parse(row.customLanes) : [],
      cards,
    };
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
  const validateMentions = (body: string) => {
    for (const userId of extractMentionUserIds(body))
      if (!publicUser(userId)) fail(400, "Unknown mentioned user");
  };
  const limits = new Map<string, { count: number; expires: number }>();
  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: "Invalid input" }, 400);
    if (err instanceof HTTPException)
      return c.json({ error: err.message }, err.status);
    if ((err as any).code?.startsWith("SQLITE_CONSTRAINT"))
      return c.json({ error: "Conflicting data" }, 409);
    return c.json({ error: "Request could not be completed" }, 500);
  });
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders))
      c.header(name, value);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("Origin") !== baseUrl
    )
      return c.json({ error: "Invalid origin" }, 403);
    const path = c.req.path;
    if (
      path.startsWith("/api/auth/") &&
      path !== "/api/auth/status" &&
      path !== "/api/auth/logout"
    ) {
      const ip = c.env?.remoteAddress ?? "unknown"; // Never trust client-controlled forwarding headers.
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
    const token = getCookie(c, "session");
    const row =
      token &&
      (db
        .query("SELECT userId FROM sessions WHERE hash=? AND expires>?")
        .get(hash(token), Date.now()) as { userId: string } | undefined);
    const user = row ? publicUser(row.userId) : null;
    if (user) c.set("user", user);
    const isPublic = [
      "/api/auth/status",
      "/api/auth/setup",
      "/api/auth/login",
      "/api/auth/oidc/login",
      "/api/auth/oidc/callback",
    ].includes(path);
    if (!isPublic && !user)
      return c.json({ error: "Authentication required" }, 401);
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 11 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
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
      return c.redirect(flow.url);
    } catch {
      return c.json({ error: "Unable to start OIDC login" }, 400);
    }
  });
  app.get("/api/auth/oidc/callback", async (c) => {
    const token = getCookie(c, "oidc_flow");
    deleteCookie(c, "oidc_flow", cookieOptions);
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
          if (existing) return existing.userId;
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
          return uid;
        })
        .immediate();
      session(c, userId);
      return c.redirect("/");
    } catch {
      return c.json({ error: "OIDC login failed" }, 400);
    }
  });
  app.get("/api/users", (c) =>
    c.json({
      users: db
        .query("SELECT id,name,email,role,createdAt FROM users ORDER BY name")
        .all() as User[],
    }),
  );
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
  app.get("/api/projects", (c) =>
    c.json({
      projects: db
        .query(`${projectSql} GROUP BY p.id ORDER BY p.createdAt,p.id`)
        .all() as Project[],
    }),
  );
  app.post("/api/projects", async (c) => {
    const input = z
      .object({
        name: text(100),
        description: z.string().max(10000).default(""),
      })
      .strict()
      .parse(await json(c));
    const slug =
      (input.name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "project") +
      "-" +
      randomBytes(4).toString("hex");
    db.query(
      "INSERT INTO projects (id,slug,name,description,createdAt) VALUES (?,?,?,?,?)",
    ).run(id(), slug, input.name, input.description, now());
    return c.json({ project: project(slug) });
  });
  app.get("/api/projects/:slug", (c) =>
    c.json({ project: project(c.req.param("slug")) }),
  );
  app.patch("/api/projects/:slug", async (c) => {
    const p = project(c.req.param("slug"));
    const input = projectUpdateFields.parse(await json(c));
    db.transaction(() => {
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
        activeProject(p.slug);
        // Update only supplied fields. Slug, identity, creation history and children stay unchanged.
        if (input.name !== undefined) db.query("UPDATE projects SET name=? WHERE id=?").run(input.name, p.id);
        if (input.description !== undefined) db.query("UPDATE projects SET description=? WHERE id=?").run(input.description, p.id);
      }
    }).immediate();
    return c.json({ project: project(p.slug) });
  });
  app.get("/api/projects/:slug/board", (c) =>
    c.json({ board: board(project(c.req.param("slug")).id) }),
  );
  app.patch("/api/projects/:slug/board", async (c) => {
    const p = activeProject(c.req.param("slug"));
    const input = boardFields.parse(await json(c));
    db.transaction(() => {
      const customLanes = [...board(p.id).customLanes];
      const seenIds = new Set<string>();
      const seenLabels = new Set<string>();
      for (const definition of input.customLanes ?? []) {
        const label = definition.label.toLowerCase();
        if (seenIds.has(definition.value) || seenLabels.has(label))
          fail(400, "Duplicate custom lane");
        seenIds.add(definition.value);
        seenLabels.add(label);
        const existing = customLanes.find((lane) => lane.value === definition.value);
        if (existing) {
          if (existing.label !== definition.label) fail(400, "Custom lanes cannot be renamed");
          continue;
        }
        if ([...LANES, ...customLanes].some((lane) => lane.label.trim().toLowerCase() === label))
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
    const p = activeProject(c.req.param("slug"));
    const lane = c.req.param("lane");
    const { index } = z
      .object({ index: z.number().int().min(0) })
      .strict()
      .parse(await json(c));
    db.transaction(() => {
      // Move within the current state so concurrent visibility changes are kept;
      // positions past the end place the lane last.
      const state = board(p.id);
      if (![...LANES, ...state.customLanes].some((definition) => definition.value === lane))
        fail(404, "Lane not found");
      if (!state.lanes.includes(lane)) fail(400, "Lane is hidden");
      db.query(
        `INSERT INTO project_boards (projectId,lanes,customLanes) VALUES (?,?,?) ON CONFLICT(projectId) DO UPDATE SET lanes=excluded.lanes`,
      ).run(
        p.id,
        JSON.stringify(moveLaneTo(state.lanes, lane, index)),
        JSON.stringify(state.customLanes),
      );
    }).immediate();
    return c.json({ board: board(p.id) });
  });
  const tagIssues = async (c: Context<Env>) => {
    const ids = z.array(z.string().uuid()).min(1).max(1000)
      .refine((values) => new Set(values).size === values.length);
    const input = z.object({ issueIds: issueIdsField, userIds: ids }).strict().parse(await json(c));
    const issues = db.transaction(() => {
      const slug = c.req.param("slug");
      const p = slug ? activeProject(slug) : null;
      const users = input.userIds.map((userId) => publicUser(userId) ?? fail(400, "Unknown mentioned user"));
      return input.issueIds.map((issueId) => {
        const current = issue(issueId);
        if (p && current.projectId !== p.id) fail(400, "Unknown project issue");
        activeIssue(issueId);
        const body = appendIssueMentions(current.body, current.title, users);
        if (body.length > ISSUE_BODY_MAX_LENGTH) fail(400, "Tagged issue exceeds body length limit");
        if (body !== current.body) {
          db.query("UPDATE issues SET body=?,labels=?,updatedAt=? WHERE id=?").run(body, JSON.stringify(bodyLabels(body)), now(), issueId);
          syncIssueTaggedUsers(db, issueId);
        }
        return issue(issueId);
      });
    }).immediate();
    return c.json({ issues });
  };
  app.post("/api/projects/:slug/issues/tag", tagIssues);
  app.post("/api/issues/tagged-users", tagIssues);
  const labelIssues = async (c: Context<Env>) => {
    const input = z.object({
      issueIds: issueIdsField,
      labels: z.array(text(50)).min(1).max(30),
    }).strict().parse(await json(c));
    const issues = db.transaction(() => {
      const slug = c.req.param("slug");
      const p = slug ? activeProject(slug) : null;
      return input.issueIds.map((issueId) => {
        const current = issue(issueId);
        if (p && current.projectId !== p.id) fail(400, "Unknown project issue");
        activeIssue(issueId);
        const body = appendIssueLabels(current.body, current.title, input.labels);
        if (body.length > ISSUE_BODY_MAX_LENGTH) fail(400, "Labeled issue exceeds body length limit");
        if (body !== current.body) {
          db.query("UPDATE issues SET body=?,labels=?,updatedAt=? WHERE id=?").run(body, JSON.stringify(bodyLabels(body)), now(), issueId);
          syncIssueTaggedUsers(db, issueId);
        }
        return issue(issueId);
      });
    }).immediate();
    return c.json({ issues });
  };
  app.post("/api/projects/:slug/issues/labels", labelIssues);
  app.post("/api/issues/labels", labelIssues);
  app.post("/api/projects/:slug/board/issues", async (c) => {
    const p = activeProject(c.req.param("slug"));
    const input = z
      .object({
        issueIds: issueIdsField,
        lane: laneField,
      })
      .strict()
      .parse(await json(c));
    db.transaction(() => {
      requireVisibleLane(p.id, input.lane);
      for (const issueId of input.issueIds) {
        if (
          !db
            .query("SELECT id FROM issues WHERE id=? AND projectId=?")
            .get(issueId, p.id)
        )
          fail(400, "Unknown project issue");
      }
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
    const result = db.transaction(() => {
      const p = activeProject(c.req.param("slug"));
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
    const p = activeProject(c.req.param("slug"));
    const input = z.object({
      issueIds: issueIdsField,
      lane: laneField,
    }).strict().parse(await json(c));
    db.transaction(() => {
      activeProject(p.slug);
      requireVisibleLane(p.id, input.lane);
      for (const issueId of input.issueIds) {
        const current = db.query("SELECT closedAt FROM issues WHERE id=? AND projectId=?")
          .get(issueId, p.id) as { closedAt: string | null } | null;
        if (!current) return fail(400, "Unknown project issue");
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
    const p = activeProject(c.req.param("slug"));
    const { lane } = z
      .object({ lane: laneField })
      .strict()
      .parse(await json(c));
    db.transaction(() => {
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
    const p = activeProject(c.req.param("slug"));
    const result = db
      .query("DELETE FROM board_issues WHERE projectId=? AND issueId=?")
      .run(p.id, c.req.param("id"));
    if (!result.changes) fail(404, "Board member not found");
    return c.json({ board: board(p.id) });
  });
  app.get("/api/projects/:slug/issues", (c) => {
    const p = project(c.req.param("slug"));
    const rows = db
      .query("SELECT id FROM issues WHERE projectId=? ORDER BY number")
      .all(p.id) as { id: string }[];
    return c.json({ issues: rows.map((r) => issue(r.id)) });
  });
  app.get("/api/issues", (c) => {
    // Return board metadata with the list so clients need no request per project.
    const rows = db.query("SELECT id,projectId FROM issues ORDER BY createdAt,id").all() as { id: string; projectId: string | null }[];
    const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
    return c.json({ issues: rows.map((r) => issue(r.id)), boards: Object.fromEntries(projectIds.map((id) => [id, board(id)])) });
  });
  const createIssue = async (c: Context<Env>) => {
    const slug = c.req.param("slug");
    const input = (slug ? issueFields : issueFields.extend({ projectId: text(100).nullable().optional() }))
      .parse(await json(c)) as z.infer<typeof issueFields> & { projectId?: string | null };
    const projectId = slug ? activeProject(slug).id : input.projectId ?? null;
    const originalBody = input.title === undefined ? input.body : prependLegacyTitle(input.title, input.body);
    const body = appendIssueLabels(originalBody, deriveIssueTitle(originalBody), input.labels);
    if (!body.trim() || body.length > ISSUE_BODY_MAX_LENGTH)
      fail(400, "Invalid issue body");
    const time = now();
    const uid = db.transaction(() => {
      if (projectId !== null) {
        const p = db.query("SELECT archivedAt FROM projects WHERE id=?").get(projectId) as { archivedAt: string | null } | null;
        if (!p) return fail(404, "Project not found");
        if (p.archivedAt) fail(409, "Project is archived");
      }
      validateMentions(body);
      const inserted = db.query(
        "INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt) VALUES (0,?,?,?,?,?,?,?,?,?) RETURNING id",
      ).get(
        projectId,
        deriveIssueTitle(originalBody),
        body,
        "backlog", // Archived legacy columns; not active issue state.
        "none",
        JSON.stringify(bodyLabels(body)),
        c.get("user").id,
        time,
        time,
      ) as { id: number };
      const uid = String(inserted.id);
      db.query("UPDATE issues SET number=id WHERE id=?").run(uid);
      syncIssueTaggedUsers(db, uid);
      return uid;
    }).immediate();
    return c.json({ issue: issue(uid) });
  };
  app.post("/api/projects/:slug/issues", createIssue);
  app.post("/api/issues", createIssue);
  app.get("/api/issues/references", (c) => {
    const query = z.string().trim().max(300).parse(c.req.query("q") ?? "");
    const numeric = query.replace(/^!/, "");
    const exactId = issueIdField.safeParse(numeric);
    const rows = exactId.success
      ? db.query("SELECT id,title,closedAt FROM issues WHERE id=? LIMIT 20").all(exactId.data)
      : db.query("SELECT id,title,closedAt FROM issues WHERE instr(lower(title),lower(?))>0 ORDER BY id DESC LIMIT 20").all(query);
    return c.json({ issues: (rows as { id: number; title: string; closedAt: string | null }[]).map((row) => ({
      id: String(row.id), number: row.id, title: row.title, state: row.closedAt ? "closed" as const : "open" as const,
    })) });
  });
  app.get("/api/issues/:id", (c) => {
    const canonical = issueIdField.safeParse(c.req.param("id"));
    if (!canonical.success) return fail(404, "Issue not found");
    const current = issue(canonical.data);
    return c.json({
      issue: current,
      comments: db.query("SELECT *,CAST(issueId AS TEXT) AS issueId FROM comments WHERE issueId=? ORDER BY createdAt,id").all(current.id) as Comment[],
    });
  });
  app.patch("/api/issues/:id", async (c) => {
    const current = activeIssue(issueIdField.parse(c.req.param("id")));
    const raw = await json(c);
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
    db.transaction(() => {
      activeIssue(current.id);
      if (input.body !== undefined) validateMentions(body);
      else if (input.title !== undefined) validateMentions(input.title);
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
          "UPDATE issues SET closedAt=?,closedById=? WHERE id=? AND closedAt IS NULL",
        ).run(merged.updatedAt, c.get("user").id, current.id);
      else if (input.state === "open")
        db.query(
          "UPDATE issues SET closedAt=NULL,closedById=NULL WHERE id=?",
        ).run(current.id);
      if (body !== current.body)
        syncIssueTaggedUsers(db, current.id);
    }).immediate();
    return c.json({ issue: issue(current.id) });
  });
  app.post("/api/issues/:id/comments", async (c) => {
    const i = activeIssue(issueIdField.parse(c.req.param("id")));
    const { body } = z
      .object({ body: text(100000) })
      .strict()
      .parse(await json(c));
    const uid = id(),
      time = now();
    db.transaction(() => {
      activeIssue(i.id);
      validateMentions(body);
      db.query("INSERT INTO comments VALUES (?,?,?,?,?,?)").run(
        uid, i.id, c.get("user").id, body, time, time,
      );
      syncIssueTaggedUsers(db, i.id);
    }).immediate();
    return c.json({
      comment: db
        .query("SELECT * FROM comments WHERE id=?")
        .get(uid) as Comment,
      issue: issue(i.id),
    });
  });
  const ownedComment = (c: any) => {
    const row = db
      .query("SELECT * FROM comments WHERE id=?")
      .get(c.req.param("id")) as Comment | null;
    if (!row) return fail(404, "Comment not found");
    if (row.authorId !== c.get("user").id && c.get("user").role !== "admin")
      fail(403, "Not permitted");
    return row;
  };
  app.patch("/api/comments/:id", async (c) => {
    const row = ownedComment(c);
    activeIssue(row.issueId);
    const { body } = z
      .object({ body: text(100000) })
      .strict()
      .parse(await json(c));
    db.transaction(() => {
      activeIssue(row.issueId);
      validateMentions(body);
      db.query("UPDATE comments SET body=?,updatedAt=? WHERE id=?").run(body, now(), row.id);
      syncIssueTaggedUsers(db, row.issueId);
    }).immediate();
    return c.json({
      comment: db
        .query("SELECT * FROM comments WHERE id=?")
        .get(row.id) as Comment,
      issue: issue(row.issueId),
    });
  });
  app.delete("/api/comments/:id", (c) => {
    const row = ownedComment(c);
    activeIssue(row.issueId);
    db.transaction(() => {
      activeIssue(row.issueId);
      db.query("DELETE FROM comments WHERE id=?").run(row.id);
      syncIssueTaggedUsers(db, row.issueId);
    }).immediate();
    return c.json({ ok: true, issue: issue(row.issueId) });
  });
  app.post("/api/uploads", async (c) => {
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
      db.query("INSERT INTO attachments VALUES (?,?,?,?)").run(
        uid,
        name,
        mime,
        file.size,
      );
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
    return c.json({
      attachment: {
        id: uid,
        name,
        url: `/api/uploads/${uid}/${encodeURIComponent(name)}`,
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
    if (!row || row.name !== c.req.param("name"))
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
  return Object.assign(app, { db, close: () => db.close(), baseUrl });
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
