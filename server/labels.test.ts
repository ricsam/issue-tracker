import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { appendIssueLabels, extractIssueLabels, labelMarkdown } from "../shared/labels";
import { isLabel } from "../shared/hashtag-matches";
import { ISSUE_BODY_MAX_LENGTH } from "../shared/issue-content";

const owned: { dir: string; app: ReturnType<typeof createApp> }[] = [];
afterEach(() => { for (const f of owned.splice(0)) { f.app.close(); rmSync(f.dir, { recursive: true, force: true }); } });
async function fixture() {
  const f = { dir: mkdtempSync(join(tmpdir(), "labels-test-")), app: undefined as unknown as ReturnType<typeof createApp> };
  f.app = createApp({ dataDir: f.dir }); owned.push(f);
  let cookie = "";
  const req = (path: string, method = "GET", body?: unknown) => f.app.request(path, { method, headers: { Origin: "http://localhost:3000", Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setup = await req("/api/auth/setup", "POST", { name: "Admin", email: "admin@example.com", password: "long-password-123" });
  cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const user = (await setup.json()).user;
  const project = (await (await req("/api/projects", "POST", { name: "Labels" })).json()).project;
  const path = `/api/projects/${project.slug}/issues`;
  return { f, req, path, user };
}

const invalidLabels = ["", "Bug", "bugFix", "BUG", "needs review", " bug", "bug ", "bug\n", "under_score", "日本語", "café", "cafe\u0301", "-bug", "bug-", "bug--fix", "-", "a]b[c", "100%", "bug%20fix", "line\nbreak", "#bug", "[bug]"];

test("only lowercase kebab hashtags parse in rendered prose, without truncating invalid tokens", () => {
  expect(extractIssueLabels("# Heading\n\n#bug #bug #日本語 #café #one-two #under_score \\#escaped #[needs review] #123 #p0-fix2"))
    .toEqual(["bug", "one-two", "escaped", "123", "p0-fix2"]);
  for (const label of invalidLabels) expect(isLabel(label)).toBeFalse();
  for (const tag of ["#Bug", "#bugFix", "#BUG", "#under_score", "#日本語", "#café", "#cafe\u0301", "#-bug", "#bug-", "#bug--fix", "#100%", "#bug%20fix", "#[bug]", "#[needs review]", "#[needs%20review]"])
    expect(extractIssueLabels(`Before ${tag} after`)).toEqual([]);
  expect(extractIssueLabels("#bug, (#needs-review). [#123] #a! #b? #c: #d;"))
    .toEqual(["bug", "needs-review", "123", "a", "b", "c", "d"]);
  expect(extractIssueLabels("word#no 中文#no ##no /#no ?#no &x=#no https://host/path#no www.host/#no `#no`\n\n```md\n#no\n```\n\n    #no\n\n[#no](https://host) ![#no](image) <span>#no</span>" )).toEqual(["no"]); // HTML inner prose is Markdown text.
  expect(extractIssueLabels("[#link](https://host/#url) <https://host/#url> `#code`\n\n~~~\n#fence" )).toEqual([]);
  for (const label of ["bug", "needs-review", "123", "p0-fix2", "a"])
    expect(extractIssueLabels(labelMarkdown(label))).toEqual([label]);
  for (const label of invalidLabels) {
    expect(() => labelMarkdown(label)).toThrow();
    expect(() => appendIssueLabels("Body", "Title", [label])).toThrow();
  }
});

test("label insertion preserves original text even with unclosed fences and HTML", () => {
  for (const body of ["# Title\n\n```\ncode", "<!-- open", "Original\ntext", "# Title\n\n<script>open"]) {
    const result = appendIssueLabels(body, "Title", ["needs-review", "bug"]);
    expect(extractIssueLabels(result)).toEqual(["needs-review", "bug"]);
    expect(result).toContain(body.startsWith("# Title") ? body.slice(8) : body);
    expect(appendIssueLabels(result, "Title", ["needs-review", "bug"])).toBe(result);
  }
});

test("API derives labels from issue body only; updates remove tags, arrays add tags, limits reject atomically", async () => {
  const { req, path, user } = await fixture();
  const created = await req(path, "POST", { body: "# Title\n\n#bug #Bug #[needs review] #bugFix", labels: ["needs-review"] });
  expect(created.status).toBe(200);
  const i = (await created.json()).issue;
  expect(i.labels).toEqual(["bug", "needs-review"]);
  expect(i.body).toContain("#Bug #[needs review] #bugFix");
  expect(i.title).toBe("Title");
  await req(`/api/issues/${i.id}/comments`, "POST", { body: "#comment-only" });
  expect((await (await req(`/api/issues/${i.id}`)).json()).issue.labels).toEqual(i.labels);
  const changed = (await (await req(`/api/issues/${i.id}`, "PATCH", { body: "# Title\n\n#new `#ignored` #New #[new] #new_tag" })).json()).issue;
  expect(changed.labels).toEqual(["new"]);
  expect((await (await req(`${path}/tag`, "POST", { issueIds: [i.id], userIds: [user.id] })).json()).issues[0].labels).toEqual(["new"]);
  for (const body of ["#" + "x".repeat(51), Array.from({ length: 31 }, (_, n) => `#label${n}`).join(" ")]) {
    expect((await req(path, "POST", { body })).status).toBe(400);
    expect((await req(`/api/issues/${i.id}`, "PATCH", { body })).status).toBe(400);
  }
  expect((await req(path, "POST", { body: "x".repeat(ISSUE_BODY_MAX_LENGTH), labels: ["overflow"] })).status).toBe(400);
});

test("all explicit label write routes reject invalid names without changing issues or history", async () => {
  const { f, req, path } = await fixture();
  const i = (await (await req(path, "POST", { body: "# Title\n\n#existing" })).json()).issue;
  const snapshot = () => ["issues", "issue_history"].map((table) => f.app.db.query(`SELECT * FROM ${table} ORDER BY id`).all());
  const before = snapshot();
  for (const invalid of invalidLabels) {
    const labels = ["valid", invalid];
    for (const route of [path, "/api/issues"])
      expect((await req(route, "POST", { body: "Body", labels })).status).toBe(400);
    expect((await req(`/api/issues/${i.id}`, "PATCH", { body: "Changed", labels })).status).toBe(400);
    for (const route of [`${path}/labels`, "/api/issues/labels"])
      expect((await req(route, "POST", { issueIds: [i.id], labels })).status).toBe(400);
  }
  expect(snapshot()).toEqual(before);
});

test("v8 migration skips invalid legacy labels, preserves content and remains idempotent", async () => {
  const { f, req, path } = await fixture();
  const i = (await (await req(path, "POST", { body: "Original" })).json()).issue;
  const body = "# Original\n\n```\n" + "x".repeat(ISSUE_BODY_MAX_LENGTH);
  f.app.db.query("UPDATE issues SET body=?,labels=?,closedAt=? WHERE id=?").run(body, JSON.stringify(["old label", "bug", "a]b", "100%"]), "2026-01-01", i.id);
  f.app.db.exec("DELETE FROM migrations WHERE version=8");
  f.app.close(); f.app = createApp({ dataDir: f.dir });
  const migrated = (await (await req(`/api/issues/${i.id}`)).json()).issue;
  expect(migrated).toMatchObject({ title: i.title, closedAt: "2026-01-01", createdAt: i.createdAt, updatedAt: i.updatedAt, labels: ["bug"] });
  expect(migrated.body).toContain(body.slice("# Original\n".length));
  expect(extractIssueLabels(migrated.body)).toEqual(["bug"]);
  f.app.close(); f.app = createApp({ dataDir: f.dir });
  expect((await (await req(`/api/issues/${i.id}`)).json()).issue).toEqual(migrated);
  f.app.db.exec("DELETE FROM migrations WHERE version=8");
  f.app.close(); f.app = createApp({ dataDir: f.dir });
  expect((await (await req(`/api/issues/${i.id}`)).json()).issue).toEqual(migrated);
});

test("v13 reindexes labels without rewriting prose, timestamps, lifecycle or issue history", async () => {
  const { f, req, path } = await fixture();
  const body = "# Original\n\n#Bug #bugFix #bug #needs-review #[needs review] #日本語 #123 #bug_bad #bug--fix";
  const i = (await (await req(path, "POST", { body })).json()).issue;
  const history = f.app.db.query("SELECT * FROM issue_history").all();
  f.app.db.query("UPDATE issues SET labels=? WHERE id=?").run(JSON.stringify(["Bug", "bugFix", "bug", "needs review", "日本語"]), i.id);
  f.app.db.exec("DELETE FROM migrations WHERE version=13");
  f.app.close(); f.app = createApp({ dataDir: f.dir });
  const migrated = (await (await req(`/api/issues/${i.id}`)).json()).issue;
  expect(migrated).toEqual(i);
  expect(migrated.labels).toEqual(["bug", "needs-review", "123"]);
  expect(f.app.db.query("SELECT * FROM issue_history").all()).toEqual(history);
  f.app.close(); f.app = createApp({ dataDir: f.dir });
  expect((await (await req(`/api/issues/${i.id}`)).json()).issue).toEqual(i);
});
