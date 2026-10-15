import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { test, expect, type Page } from "@playwright/test";
import { pluginRegistry, type PluginAdminSettings, type ExternalLink } from "../shared/plugins";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Plugins ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "# Fix the launch integration\n\nSaved issue Markdown." } })).json();
  const { comment } = await (await page.request.post(`/api/issues/${issue.id}/comments`, { headers, data: { body: "Saved discussion context" } })).json();
  return { project, issue, comment, headers };
}

// Mock only the plugin contract: auth, projects, issues, editors and comments are
// real. Server suites separately test encryption, validation and feed behavior.
test("generated admin form preserves drafts during status refresh and clears secret after save", async ({ page, baseURL }) => {
  const { project } = await seed(page, baseURL!);
  let plugin: PluginAdminSettings = { ...pluginRegistry[0]!, enabled: false, values: { baseUrl: "https://r5d.dev", team: "", defaultShare: "none", projects: [] }, hasSecrets: { apiKey: false }, status: { state: "disabled" } };
  const writes: { enabled: boolean; values: Record<string, unknown> }[] = [];
  await page.route("**/api/admin/plugins**", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON(); writes.push(input);
      const { apiKey: _secret, ...values } = input.values;
      plugin = { ...plugin, enabled: input.enabled, values, hasSecrets: { apiKey: true }, status: { state: "running" } };
      await route.fulfill({ json: { plugin } });
    } else await route.fulfill({ json: { plugins: [plugin] } });
  });
  await page.goto("/admin");
  const form = page.getByRole("region", { name: "r5d plugin settings" });
  await form.getByLabel("Enable r5d", { exact: true }).check();
  await form.getByLabel("Team URL name").fill("demo-team");
  await form.getByLabel("Team API key").fill("r5d_team_browser_fixture");
  await form.getByLabel("Default share").selectOption("branch");
  await form.getByRole("button", { name: "Add project mapping" }).click();
  await form.getByLabel("Project 1", { exact: true }).selectOption(project.id);
  await form.getByLabel("Git remote 1").fill("git@github.com:acme/repo.git");
  await form.getByLabel("Default branch 1").fill("main");
  await form.getByRole("button", { name: "Save r5d settings" }).click();
  await expect(form.getByLabel("Team API key")).toHaveValue("");
  await expect(form.getByLabel("Team API key")).toHaveAttribute("placeholder", /leave blank/);
  expect(writes[0]).toEqual({ enabled: true, values: { baseUrl: "https://r5d.dev", team: "demo-team", apiKey: "r5d_team_browser_fixture", defaultShare: "branch", projects: [{ projectId: project.id, remote: "git@github.com:acme/repo.git", defaultBranch: "main" }] } });
  await form.getByLabel("Team URL name").fill("unsaved-team");
  plugin = { ...plugin, status: { state: "error", error: "Team key rejected" } };
  await expect(form.getByText("Team key rejected")).toBeVisible({ timeout: 15000 });
  await expect(form.getByLabel("Team URL name")).toHaveValue("unsaved-team");
  await form.getByRole("button", { name: "Save r5d settings" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]!.values.apiKey).toBe("");
});

for (const embedded of [false, true]) {
  test(`${embedded ? "panel" : "full page"}: launch is synchronous, encoded, mapped and uses saved discussion only`, async ({ page, baseURL }) => {
    const { project, issue, comment } = await seed(page, baseURL!);
    await page.addInitScript(() => {
      (window as unknown as { opened: unknown[] }).opened = [];
      window.open = (...args) => { (window as unknown as { opened: unknown[] }).opened.push(args); return null; };
    });
    await page.route("**/api/plugins", (route) => route.fulfill({ json: { baseUrl: "https://tracker.example.test/base", plugins: [{ id: "r5d", values: { baseUrl: "https://r5d.example.test", team: "demo", defaultShare: "branch", projects: [{ projectId: project.id, remote: "git@github.com:acme/repo.git", defaultBranch: "develop" }] } }] } }));
    await page.goto(embedded ? `/projects/${project.slug}` : `/issues/${issue.id}`);
    if (embedded) await page.locator(`a[data-issue-id="${issue.id}"]`).click();
    await page.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
    await page.locator(".detail-form").getByLabel("Markdown source").fill("Unsaved body must not launch");
    await page.locator(".comments [contenteditable=true]").fill("Unsaved comment must not launch");
    const action = page.getByRole("button", { name: "Implement with r5d", exact: true });
    await expect(action).toBeEnabled(); await action.click();
    const opened = await page.evaluate(() => (window as unknown as { opened: string[][] }).opened);
    expect(opened).toHaveLength(1);
    const [url, target, features] = opened[0]!;
    expect(target).toBe("_blank"); expect(features).toBe("noopener,noreferrer");
    expect(url).toMatch(/^https:\/\/r5d.example.test\/launch#[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(inflateSync(Buffer.from(new URL(url!).hash.slice(1), "base64url")).toString());
    expect(payload).toEqual({ v: 1, remote: "git@github.com:acme/repo.git", branch: { mode: "new", name: `issue/${issue.number}-fix-the-launch-integration`.slice(0, 40), from: "develop" }, share: { team: "demo", scope: "branch" }, workItems: [{ source: "threadline", kind: "issue", id: `tracker.example.test#${issue.number}`, url: `https://tracker.example.test/base/issues/${issue.number}`, title: issue.title, snapshot: `${issue.body}\n\n## Comment by Alex Morgan (${comment.createdAt})\n\n${comment.body}` }] });
  });
}

test("unmapped launch omits remote, branch and sharing and enforces payload limits", async ({ page, baseURL }) => {
  const { issue } = await seed(page, baseURL!);
  await page.addInitScript(() => { window.open = (url) => { (window as unknown as { launchUrl: string }).launchUrl = String(url); return null; }; });
  await page.route("**/api/plugins", (route) => route.fulfill({ json: { baseUrl: "https://tracker.test", plugins: [{ id: "r5d", values: { baseUrl: "https://r5d.dev", defaultShare: "none", projects: [] } }] } }));
  await page.route(`**/api/issues/${issue.id}`, (route) => route.fulfill({ json: { issue: { ...issue, title: "Long title ".repeat(100), body: "x".repeat(120000) }, comments: [] } }));
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Implement with r5d" }).click();
  const url = await page.evaluate(() => (window as unknown as { launchUrl: string }).launchUrl);
  const payload = JSON.parse(inflateSync(Buffer.from(new URL(url).hash.slice(1), "base64url")).toString());
  expect(Object.keys(payload).sort()).toEqual(["v", "workItems"]);
  expect(payload.workItems[0].title).toHaveLength(500);
  expect(payload.workItems[0].snapshot).toHaveLength(100000);
});

test("external badges appear on cards, table and details, refresh without losing drafts, and reject unsafe URLs", async ({ page, baseURL }) => {
  const { project, issue, headers } = await seed(page, baseURL!);
  expect((await page.request.put(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [issue.id], lane: "todo" } })).ok()).toBeTruthy();
  let links: ExternalLink[] = [
    { pluginId: "r5d", externalId: "session", title: "Agent session", url: "https://r5d.test/team/session", status: "running", tone: "info" },
    { pluginId: "r5d", externalId: "unsafe", title: "Unsafe", url: "javascript:alert(1)", status: "bad", tone: "danger" },
  ];
  await page.route(`**/api/issues/${issue.id}/external-links`, (route) => route.fulfill({ json: { links } }));
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card .external-link")).toHaveText("running");
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator(".issue-table .external-link")).toHaveText("running");
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  const detail = page.locator(".detail-container");
  await expect(detail.getByRole("link", { name: "Agent session · running" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(detail.getByRole("link", { name: "Unsafe" })).toHaveCount(0);
  await detail.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await detail.locator(".detail-form").getByLabel("Markdown source").fill("Keep my draft");
  links = [{ ...links[0]!, status: "completed", tone: "success" }];
  await expect(detail.getByRole("link", { name: "Agent session · completed" })).toBeVisible({ timeout: 15000 });
  await expect(detail.locator(".detail-form").getByLabel("Markdown source")).toHaveValue("Keep my draft");
  await expect(page.locator(".issue-table .external-link")).toHaveText("completed");
});

test("unsafe integration launch URLs are refused", async ({ page, baseURL }) => {
  const { issue } = await seed(page, baseURL!);
  await page.route("**/api/plugins", (route) => route.fulfill({ json: { baseUrl: "https://tracker.test", plugins: [{ id: "r5d", values: { baseUrl: "javascript:alert(1)", defaultShare: "none", projects: [] } }] } }));
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole("button", { name: "Implement with r5d" })).toBeDisabled();
  await expect(page.getByText("The integration requires valid HTTP(S) base URLs.")).toBeVisible();
});

test("real browser GET plugin endpoints never expose secret fields", async ({ page, baseURL }) => {
  await seed(page, baseURL!);
  await page.goto("/admin");
  const results = await page.evaluate(async () => Promise.all(["/api/plugins", "/api/admin/plugins"].map(async (url) => {
    const response = await fetch(url); return { status: response.status, body: await response.json() };
  })));
  for (const result of results) {
    expect(result.status).toBe(200);
    for (const plugin of result.body.plugins) expect(plugin.values).not.toHaveProperty("apiKey");
  }
});
