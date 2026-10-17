import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./api-access";
import { LANES, type PersonalBoard, type User } from "../shared/types";
import { defaultIssueFilters } from "../shared/issue-filters";
import { issueFiltersField } from "./issue-filters";
import { issueAccessParams, visibleIssueSql, workspaceIdFor } from "./project-access";

const fail = (status: 400 | 404 | 409, message: string): never => { throw new HTTPException(status, { message }); };
const lane = z.string().min(1).max(100);
const laneList = z.array(lane).max(LANES.length + 30).refine((v) => new Set(v).size === v.length);
const fields = z.object({
  name: z.string().trim().min(1).max(100),
  filters: issueFiltersField(),
  search: z.string().max(1000),
  lanes: laneList.min(1),
  customLanes: z.array(z.object({
    value: z.string().regex(/^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    label: z.string().trim().min(1).max(60),
  }).strict()).max(30),
  laneLabels: z.record(lane, z.string().trim().min(1).max(60)).refine((labels) => Object.keys(labels).length <= LANES.length + 30),
  cards: z.array(z.object({ issueId: z.string().regex(/^[1-9][0-9]*$/).max(16).refine((v) => Number.isSafeInteger(Number(v))), lane }).strict()).max(10000)
    .refine((cards) => new Set(cards.map((c) => c.issueId)).size === cards.length),
  collapsedLanes: laneList,
  hiddenLanes: laneList,
}).strict();
const createFields = fields.partial().required({ name: true });
const patchFields = fields.partial().extend({ revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
type Row = { id: string; userId: string; workspaceId: string; name: string; config: string; revision: number; createdAt: string; updatedAt: string };

export function registerPersonalBoards(app: Hono<AppEnv>, db: Database, json: (c: any) => Promise<unknown>) {
  // Public workspace discovery is not membership. Revocation also hides personal state.
  app.use("/api/me/boards*", async (c, next) => {
    const user = c.get("user");
    if (user.role !== "admin" && !db.query("SELECT 1 FROM workspace_members WHERE workspaceId=? AND userId=?").get(workspaceIdFor(user), user.id)) fail(404, "Workspace not found");
    await next();
  });
  const readable = (issueId: string, user: User) => !!db.query(`SELECT 1 FROM issues i WHERE i.id=? AND ${visibleIssueSql}`).get(issueId, ...issueAccessParams(user));
  const row = (id: string, user: User) => db.query("SELECT * FROM personal_boards WHERE id=? AND userId=? AND workspaceId=?").get(id, user.id, workspaceIdFor(user)) as Row | null;
  const requireRow = (id: string, user: User) => row(id, user) ?? fail(404, "Board not found");
  const serialize = (row: Row, user: User): PersonalBoard => {
    const { config, ...base } = row;
    const cards = db.query(`SELECT CAST(b.issueId AS TEXT) AS issueId,b.lane FROM personal_board_cards b JOIN issues i ON i.id=b.issueId
      WHERE b.boardId=? AND ${visibleIssueSql} ORDER BY b.position`).all(row.id, ...issueAccessParams(user));
    return { ...base, ...JSON.parse(config), cards };
  };
  const validate = (board: PersonalBoard, user: User) => {
    const definitions = [...LANES, ...board.customLanes];
    const known = new Set(definitions.map((d) => d.value));
    if (known.size !== definitions.length || [...board.lanes, ...board.hiddenLanes, ...board.collapsedLanes, ...Object.keys(board.laneLabels ?? {}), ...board.cards.map((c) => c.lane)].some((l) => !known.has(l))) fail(400, "Unknown or duplicate lane");
    const labels = definitions.map((d) => (board.laneLabels?.[d.value] ?? d.label).toLowerCase());
    if (new Set(labels).size !== labels.length) fail(400, "Duplicate lane label");
    for (const card of board.cards) if (!readable(card.issueId, user)) fail(404, "Issue not found");
  };
  const save = (board: PersonalBoard, user: User, replaceCards = true) => {
    const { id, userId, workspaceId, name, revision, createdAt, updatedAt, cards, ...config } = board;
    db.query(`INSERT INTO personal_boards (id,userId,workspaceId,name,config,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,revision=excluded.revision,updatedAt=excluded.updatedAt`)
      .run(id, userId, workspaceId, name, JSON.stringify(config), revision, createdAt, updatedAt);
    if (replaceCards) {
      // Retain hidden placements across temporary access revocation, even when
      // the client replaces the visible subset. Config-only saves never reorder.
      db.query(`DELETE FROM personal_board_cards WHERE boardId=? AND issueId IN
        (SELECT i.id FROM issues i WHERE ${visibleIssueSql})`).run(id, ...issueAccessParams(user));
      cards.forEach((card, position) => db.query("INSERT INTO personal_board_cards VALUES (?,?,?,?)").run(id, card.issueId, card.lane, position));
    }
    // A removed custom definition must not leave retained, inaccessible cards
    // pointing at an invalid lane when access returns. Only private placement
    // metadata changes; neither hidden IDs nor their existence leave this query.
    const knownLanes = [...LANES, ...board.customLanes].map((lane) => lane.value);
    db.query(`UPDATE personal_board_cards SET lane=? WHERE boardId=? AND lane NOT IN (${knownLanes.map(() => "?").join(",")})`)
      .run(board.lanes[0]!, id, ...knownLanes);
  };
  app.get("/api/me/boards", (c) => {
    const user = c.get("user");
    const rows = db.query("SELECT * FROM personal_boards WHERE userId=? AND workspaceId=? ORDER BY createdAt,id").all(user.id, workspaceIdFor(user)) as Row[];
    return c.json({ boards: rows.map((r) => serialize(r, user)) });
  });
  app.post("/api/me/boards", async (c) => {
    const input = createFields.parse(await json(c)), user = c.get("user");
    const board = db.transaction(() => {
      const time = new Date().toISOString();
      const board: PersonalBoard = { id: crypto.randomUUID(), userId: user.id, workspaceId: workspaceIdFor(user),
        filters: defaultIssueFilters, search: "", lanes: LANES.map((l) => l.value), customLanes: [], laneLabels: {}, cards: [], collapsedLanes: [], hiddenLanes: [],
        ...input, revision: 1, createdAt: time, updatedAt: time };
      validate(board, user);
      save(board, user);
      return board;
    }).immediate();
    return c.json({ board }, 201);
  });
  app.get("/api/me/boards/:id", (c) => c.json({ board: serialize(requireRow(c.req.param("id"), c.get("user")), c.get("user")) }));
  app.patch("/api/me/boards/:id", async (c) => {
    // Resolve ownership before parsing to keep foreign/missing IDs indistinguishable.
    requireRow(c.req.param("id"), c.get("user"));
    const input = patchFields.parse(await json(c)), user = c.get("user");
    const board = db.transaction(() => {
      const old = serialize(requireRow(c.req.param("id"), user), user);
      if (input.revision !== old.revision) fail(409, "Board revision conflict");
      const board = { ...old, ...input, revision: old.revision + 1, updatedAt: new Date().toISOString() };
      validate(board, user);
      save(board, user, input.cards !== undefined);
      return board;
    }).immediate();
    return c.json({ board });
  });
  app.delete("/api/me/boards/:id", (c) => {
    const board = requireRow(c.req.param("id"), c.get("user"));
    db.query("DELETE FROM personal_boards WHERE id=? AND userId=? AND workspaceId=?").run(board.id, board.userId, board.workspaceId);
    return c.json({ ok: true });
  });
}
