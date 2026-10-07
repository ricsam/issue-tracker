import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { extractMentionUserIds, mentionMarkdown, mentionUserId } from "../shared/mentions";

const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => {
  for (const e of owned.splice(0)) {
    e.app.close();
    rmSync(e.dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mentions-test-"));
  const entry = { dir, app: createApp({ dataDir: dir }) };
  owned.push(entry);
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown, auth = cookie, origin = "http://localhost:3000") => entry.app.request(path, {
    method, headers: { Origin: origin, Cookie: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const password = "long-password-123";
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (await setup.json()).user;
  const member = (await (await req("/api/admin/users", "POST", { name: "Member", email: "member@example.com", password })).json()).user;
  const login = await req("/api/auth/login", "POST", { email: "member@example.com", password }, "");
  const memberCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const project = (await (await req("/api/projects", "POST", { name: "Mentions" })).json()).project;
  const path = `/api/projects/${project.slug}`;
  const create = async (body = "Issue") => (await (await req(`${path}/issues`, "POST", { body })).json()).issue;
  return { entry, req, admin, member, memberCookie, path, create };
}

test("Markdown AST recognizes only actual mention links and safely escapes names", () => {
  const id = crypto.randomUUID();
  const link = mentionMarkdown({ id, name: "A [name] *with* `syntax` &amp; \\" });
  expect(extractMentionUserIds(link + " " + mentionMarkdown({ id, name: "Renamed" }))).toEqual([id]);
  expect(mentionUserId(`mention:${id.toUpperCase()}`)).toBe(id);
  for (const url of [`mention:${id}/`, `mention:${id}?x`, "mention:bad", `https://example.com/${id}`]) expect(mentionUserId(url)).toBeNull();
  for (const body of ["`" + link + "`", "```md\n" + link + "\n```", "    " + link, "!" + link, "\\" + link, `<a href="mention:${id}">Name</a>`, `[unused]: mention:${id}`])
    expect(extractMentionUserIds(body)).toEqual([]);
  expect(extractMentionUserIds(`[@Name][person]\n\n[person]: mention:${id}`)).toEqual([id]);
});

test("union is deduped across issue and comments, stable through rename and removes only the final reference", async () => {
  const f = await fixture();
  const a = mentionMarkdown(f.admin), b = mentionMarkdown(f.member);
  const i = await f.create(a + " " + a);
  expect(i.taggedUserIds).toEqual([f.admin.id]);
  const ip = `/api/issues/${i.id}`;
  const c1 = await (await f.req(`${ip}/comments`, "POST", { body: a + " " + b })).json();
  const both = [f.admin.id, f.member.id].sort();
  expect(c1.issue.taggedUserIds).toEqual(both);
  const c2 = await (await f.req(`${ip}/comments`, "POST", { body: b })).json();
  f.entry.app.db.query("UPDATE users SET name=? WHERE id=?").run("Renamed", f.member.id);
  expect((await (await f.req(ip, "PATCH", { body: "No mentions", assigneeId: f.member.id })).json()).issue.taggedUserIds).toEqual(both);
  expect((await (await f.req(`/api/comments/${c1.comment.id}`, "PATCH", { body: "Removed" })).json()).issue.taggedUserIds).toEqual([f.member.id]);
  expect((await (await f.req(`${f.path}/issues`)).json()).issues[0].taggedUserIds).toEqual([f.member.id]);
  expect(await (await f.req(`/api/comments/${c2.comment.id}`, "DELETE")).json()).toMatchObject({ ok: true, issue: { taggedUserIds: [] } });
  expect((await (await f.req(ip)).json()).issue.taggedUserIds).toEqual([]);
});

test("unknown UUID writes fail atomically, malformed IDs and code are not associations", async () => {
  const f = await fixture();
  const i = await f.create(mentionMarkdown(f.admin));
  const ip = `/api/issues/${i.id}`;
  const missing = mentionMarkdown({ id: crypto.randomUUID(), name: "Stale user" });
  expect((await f.req(`${f.path}/issues`, "POST", { body: missing })).status).toBe(400);
  expect((await f.req(ip, "PATCH", { body: missing, state: "closed", labels: ["changed"] })).status).toBe(400);
  expect((await (await f.req(ip)).json()).issue).toEqual(i);
  expect((await f.req(`${ip}/comments`, "POST", { body: missing })).status).toBe(400);
  const c = (await (await f.req(`${ip}/comments`, "POST", { body: mentionMarkdown(f.member) })).json()).comment;
  expect((await f.req(`/api/comments/${c.id}`, "PATCH", { body: missing })).status).toBe(400);
  expect((await (await f.req(ip)).json()).comments).toEqual([c]);
  expect((await (await f.req(`${f.path}/issues`)).json()).issues).toHaveLength(1);
  const ignored = await f.create(`Example \`${missing}\` and [bad](mention:not-a-uuid)`);
  expect(ignored.taggedUserIds).toEqual([]);
});

test("v7 backfills known IDs only, preserves history and restarts idempotently", async () => {
  const f = await fixture();
  const i = await f.create("Original");
  const body = mentionMarkdown(f.admin) + " " + mentionMarkdown({ id: crypto.randomUUID(), name: "Unknown" });
  const c = (await (await f.req(`/api/issues/${i.id}/comments`, "POST", { body: mentionMarkdown(f.member) })).json()).comment;
  f.entry.app.db.query("UPDATE issues SET body=?,closedAt=?,closedById=? WHERE id=?").run(body, "2026-01-01", f.admin.id, i.id);
  f.entry.app.db.exec("DROP TABLE issue_tagged_users; DELETE FROM migrations WHERE version=7;");
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  const first = await (await f.req(`/api/issues/${i.id}`)).json();
  expect(first.issue).toMatchObject({ body, closedAt: "2026-01-01", taggedUserIds: [f.admin.id, f.member.id].sort() });
  expect(first.comments).toEqual([c]);
  // Unrelated writes and comment changes do not reject unknown historical links.
  expect((await f.req(`/api/issues/${i.id}`, "PATCH", { labels: ["ok"] })).status).toBe(200);
  expect((await f.req(`/api/comments/${c.id}`, "PATCH", { body: "Changed" })).status).toBe(200);
  const before = await (await f.req(`/api/issues/${i.id}`)).json();
  f.entry.app.close();
  f.entry.app = createApp({ dataDir: f.entry.dir });
  expect(await (await f.req(`/api/issues/${i.id}`)).json()).toEqual(before);
  expect(f.entry.app.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("association storage failures roll back content and lifecycle changes together", async () => {
  const f = await fixture();
  const i = await f.create(mentionMarkdown(f.admin));
  const ip = `/api/issues/${i.id}`;
  const c = (await (await f.req(`${ip}/comments`, "POST", { body: "Original" })).json()).comment;
  const before = await (await f.req(ip)).json();
  f.entry.app.db.exec(`CREATE TRIGGER reject_tags BEFORE INSERT ON issue_tagged_users BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
  expect((await f.req(ip, "PATCH", { body: mentionMarkdown(f.member), state: "closed" })).status).toBe(409);
  expect((await f.req(`${ip}/comments`, "POST", { body: "New" })).status).toBe(409);
  expect((await f.req(`/api/comments/${c.id}`, "PATCH", { body: "Changed" })).status).toBe(409);
  expect((await f.req(`/api/comments/${c.id}`, "DELETE")).status).toBe(409);
  expect(await (await f.req(ip)).json()).toEqual(before);
});

test("auth, CSRF, comment ownership and archive protections remain effective", async () => {
  const f = await fixture();
  const i = await f.create("Issue");
  const ip = `/api/issues/${i.id}`;
  const body = mentionMarkdown(f.member);
  const c = (await (await f.req(`${ip}/comments`, "POST", { body })).json()).comment;
  expect((await f.req(ip, "PATCH", { body }, "")).status).toBe(401);
  expect((await f.req(ip, "PATCH", { body }, f.memberCookie, "https://evil.example")).status).toBe(403);
  expect((await f.req(`/api/comments/${c.id}`, "PATCH", { body: "Remove" }, f.memberCookie)).status).toBe(403);
  expect((await f.req(`/api/comments/${c.id}`, "DELETE", undefined, f.memberCookie)).status).toBe(403);
  expect((await f.req(ip, "PATCH", { body }, f.memberCookie)).status).toBe(200);
  await f.req(f.path, "PATCH", { archived: true });
  for (const [path, method, input] of [[ip, "PATCH", { body: "Remove" }], [`${ip}/comments`, "POST", { body }], [`/api/comments/${c.id}`, "PATCH", { body: "Remove" }], [`/api/comments/${c.id}`, "DELETE", undefined], [`${f.path}/issues`, "POST", { body }]] as const)
    expect((await f.req(path, method, input)).status).toBe(409);
  expect((await (await f.req(ip)).json()).issue.taggedUserIds).toEqual([f.member.id]);
});
