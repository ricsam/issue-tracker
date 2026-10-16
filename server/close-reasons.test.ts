import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openDatabase } from "./db";

const owned: { dir: string; close: () => void }[] = [];
afterEach(() => { for (const item of owned.splice(0)) { item.close(); rmSync(item.dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "close-reasons-"));
  const app = createApp({ dataDir: dir });
  owned.push({ dir, close: app.close });
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie) => app.request(path, {
    method, headers: { Origin: "http://localhost:3000", Cookie: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (await setup.json()).user;
  const member = (await (await req("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password: "long-password-123" })).json()).user;
  const login = await req("/api/auth/login", "POST", { email: "member@example.com", password: "long-password-123" }, "");
  const memberCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const project = (await (await req("/api/projects", "POST", { name: "Close" })).json()).project;
  const create = async (extra = {}) => (await (await req(`/api/projects/${project.slug}/issues`, "POST", { body: "# Issue", ...extra })).json()).issue;
  return { app, req, create, project, admin, member, memberCookie };
}

test("atomic close records reason and comment, preserves board, rejects retry, and reopening resets metadata", async () => {
  const f = await fixture(), i = await f.create(), target = await f.create();
  await f.req(`/api/projects/${f.project.slug}/board/issues`, "POST", { issueIds: [i.id], lane: "todo" });
  const body = { reason: "duplicate", duplicateOfId: target.id, comment: "Explanation" };
  const response = await f.req(`/api/issues/${i.id}/close`, "POST", body);
  expect(response.status).toBe(200);
  const closed = await response.json();
  expect(closed.issue).toMatchObject({ state: "closed", closeReason: "duplicate", duplicateOfId: target.id });
  expect(closed.comment).toMatchObject({ body: "Explanation", issueId: i.id });
  expect(f.app.db.query("SELECT lane FROM board_issues WHERE issueId=?").get(i.id)).toEqual({ lane: "todo" });
  const history = (await (await f.req(`/api/issues/${i.id}/history`)).json()).history;
  expect(history.flatMap((h: any) => h.changes)).toContainEqual({ field: "closeReason", before: null, after: "duplicate" });
  expect(history.flatMap((h: any) => h.changes).some((c: any) => c.field === "duplicateOfId")).toBe(false);
  expect((await f.req(`/api/issues/${i.id}/close`, "POST", body)).status).toBe(409);
  expect((await (await f.req(`/api/issues/${i.id}`)).json()).comments).toHaveLength(1);
  const redundant = (await (await f.req(`/api/issues/${i.id}`, "PATCH", { state: "closed" })).json()).issue;
  expect(redundant).toMatchObject({ closeReason: "duplicate", duplicateOfId: target.id, closedAt: closed.issue.closedAt });
  expect((await (await f.req(`/api/issues/${i.id}`, "PATCH", { state: "open" })).json()).issue)
    .toMatchObject({ state: "open", closeReason: null, duplicateOfId: null, closedAt: null });
  expect((await (await f.req(`/api/issues/${i.id}`, "PATCH", { state: "closed" })).json()).issue.closeReason).toBe("completed");
});

test("invalid target/comment leaves issue, history, tags and attachment references unchanged, even after writes", async () => {
  const f = await fixture(), i = await f.create();
  const snapshot = () => JSON.stringify(["issues", "comments", "issue_history", "issue_tagged_users", "issue_attachments"].map((table) => f.app.db.query(`SELECT * FROM ${table}`).all()));
  const attachmentId = crypto.randomUUID();
  f.app.db.query("INSERT INTO attachments (id,name,mime,size,uploaderId) VALUES (?,'file','text/plain',1,?)").run(attachmentId, f.admin.id);
  const before = snapshot();
  for (const input of [
    { reason: "duplicate" }, { reason: "duplicate", duplicateOfId: i.id },
    { reason: "duplicate", duplicateOfId: "01" }, { reason: "completed", duplicateOfId: i.id },
    { reason: "other" }, { reason: "completed", comment: " " },
    { reason: "completed", comment: "[@Missing](mention:00000000-0000-4000-8000-000000000000)" },
    { reason: "completed", comment: "[missing](/api/uploads/00000000-0000-4000-8000-000000000000/file)" },
  ]) {
    expect((await f.req(`/api/issues/${i.id}/close`, "POST", input)).status).toBe(input.comment?.includes("/api/uploads/") ? 404 : 400);
    expect(snapshot()).toBe(before);
  }
  // Force a failure after comment/tag/history writes to verify the outer transaction rolls all of them back.
  f.app.db.exec(`CREATE TRIGGER fail_close_history BEFORE INSERT ON issue_history WHEN NEW.action='updated' BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
  expect((await f.req(`/api/issues/${i.id}/close`, "POST", { reason: "not_planned", comment: `[@Member](mention:${f.member.id}) [file](/api/uploads/${attachmentId}/file)` })).status).toBe(409);
  expect(snapshot()).toBe(before);
});

test("duplicate targets must be published and visible, and access loss redacts detail and list", async () => {
  const f = await fixture(), i = await f.create(), target = await f.create();
  const privateProject = (await (await f.req("/api/projects", "POST", { name: "Secret", visibility: "private" })).json()).project;
  await f.req(`/api/issues/${target.id}`, "PATCH", { projectId: privateProject.id });
  expect((await f.req(`/api/issues/${i.id}/close`, "POST", { reason: "duplicate", duplicateOfId: target.id }, f.memberCookie)).status).toBe(404);
  expect((await f.req(`/api/issues/${i.id}/close`, "POST", { reason: "duplicate", duplicateOfId: target.id })).status).toBe(200);
  expect((await (await f.req(`/api/issues/${i.id}`, "GET", undefined, f.memberCookie)).json()).issue.duplicateOfId).toBeNull();
  const list = await (await f.req(`/api/projects/${f.project.slug}/issues`, "GET", undefined, f.memberCookie)).json();
  expect(list.issues.find((row: any) => row.id === i.id).duplicateOfId).toBeNull();
  const draft = await f.create({ state: "draft" });
  const open = await f.create();
  expect((await f.req(`/api/issues/${open.id}/close`, "POST", { reason: "duplicate", duplicateOfId: draft.id })).status).toBe(404);
  expect((await f.req(`/api/issues/${draft.id}/close`, "POST", { reason: "completed" })).status).toBe(409);
  await f.req(`/api/projects/${privateProject.slug}`, "PATCH", { archived: true });
  expect((await f.req(`/api/issues/${open.id}/close`, "POST", { reason: "duplicate", duplicateOfId: target.id })).status).toBe(200);
  await f.req(`/api/projects/${f.project.slug}`, "PATCH", { archived: true });
  expect((await f.req(`/api/issues/${i.id}/close`, "POST", { reason: "completed" })).status).toBe(409);
});

test("migration 21 backfills only closed issues and survives restart without altering content or times", () => {
  const dir = mkdtempSync(join(tmpdir(), "close-migration-"));
  let db = openDatabase(join(dir, "db.sqlite"), 20);
  owned.push({ dir, close: () => db.close() });
  db.exec(`INSERT INTO users VALUES ('u','User','u@example.com','hash','admin','created');
    INSERT INTO issues (number,projectId,title,body,status,priority,labels,authorId,createdAt,updatedAt,closedAt,closedById)
    VALUES (1,NULL,'Closed','# Closed','todo','none','[]','u','created','updated','closed','u'),
    (2,NULL,'Open','# Open','todo','none','[]','u','created','updated',NULL,NULL);`);
  db.close();
  db = openDatabase(join(dir, "db.sqlite"));
  expect(db.query("SELECT closeReason,duplicateOfId,closedAt,updatedAt,body FROM issues WHERE id=1").get())
    .toEqual({ closeReason: "completed", duplicateOfId: null, closedAt: "closed", updatedAt: "updated", body: "# Closed" });
  expect(db.query("SELECT closeReason FROM issues WHERE id=2").get()).toEqual({ closeReason: null });
  db.query("UPDATE issues SET closeReason='not_planned' WHERE id=1").run();
  db.close(); db = openDatabase(join(dir, "db.sqlite"));
  expect(db.query("SELECT closeReason FROM issues WHERE id=1").get()).toEqual({ closeReason: "not_planned" });
});
