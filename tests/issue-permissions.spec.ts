import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const password = "local-browser-test-password";
test.use({ extraHTTPHeaders: { Origin: `http://127.0.0.1:${process.env.E2E_PORT || 4179}` } });
async function admin(request: APIRequestContext) {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(`/api/auth/${setupRequired ? "setup" : "login"}`, { data: {
    email: "alex@example.test", password, ...(setupRequired ? { name: "Alex Morgan" } : {}),
  } })).ok()).toBeTruthy();
}

for (const width of [1440, 390]) test(`permission scopes, author policy and creator-only lanes at ${width}px`, async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width, height: 900 });
  await admin(page.request);
  const tag = Date.now().toString(36), slug = `permissions-${tag}`, email = `reporter-${tag}@example.test`;
  const headers = { "X-Workspace-Slug": slug };
  expect((await page.request.post("/api/workspaces", { data: { name: "Permissions team", slug, visibility: "hidden" } })).ok()).toBeTruthy();
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Reporting project", slug: "reports" } })).json()).project;
  const other = (await (await page.request.post("/api/projects/reports/issues", { headers, data: { body: "Other author issue", lane: "todo" } })).json()).issue;
  const member = (await (await page.request.post("/api/admin/users", { data: { name: "Reporter", email, password } })).json()).user;

  await page.goto(`/w/${slug}/settings`);
  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByLabel("Default permissions", { exact: true }).selectOption("none");
  await dialog.getByLabel("Permissions for Reporting project", { exact: true }).selectOption("create-issue");
  await expect(dialog.getByText("Scope:", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Policies:", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.R5D_ROOT && process.env.R5D_SESSION_ID) {
    const artifacts = join(process.env.R5D_ROOT, "artifacts", process.env.R5D_SESSION_ID);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, `issue-permissions-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const context = await browser.newContext({ baseURL, viewport: { width, height: 900 }, extraHTTPHeaders: { Origin: baseURL! } });
  try {
    const reporter = await context.newPage();
    expect((await reporter.request.post("/api/auth/login", { data: { email, password } })).ok()).toBeTruthy();
    await reporter.goto(`/w/${slug}/projects`);
    await expect(reporter.getByRole("button", { name: "Create project", exact: true })).toHaveCount(0);
    await reporter.goto(`/w/${slug}/projects/reports`);
    await expect(reporter.getByRole("button", { name: "Edit project", exact: true })).toHaveCount(0);
    await expect(reporter.locator("a.issue-link")).toHaveCount(0);
    await reporter.getByRole("button", { name: "Create issue", exact: true }).click();
    const composer = reporter.getByRole("dialog");
    await composer.getByRole("textbox", { name: "Issue", exact: true }).fill("My own report");
    await composer.getByLabel("Board lane", { exact: true }).selectOption("todo");
    await composer.getByRole("button", { name: "Create issue", exact: true }).click();
    await expect(reporter.getByRole("link", { name: "View issue", exact: true })).toBeVisible();
    await composer.getByRole("button", { name: "Done", exact: true }).click();
    const own = (await (await reporter.request.get("/api/issues", { headers })).json()).issues[0];
    expect(own.authorId).toBe(member.id);
    await reporter.goto(`/w/${slug}/issues/${own.number}`);
    await reporter.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
    await reporter.getByLabel("Markdown source").first().fill("My edited report");
    await reporter.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(reporter.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await reporter.getByRole("textbox", { name: "Share an update or ask a question…", exact: true }).fill("Reporter follow-up");
    await reporter.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(reporter.locator(".comment").filter({ hasText: "Reporter follow-up" })).toBeVisible();
    await reporter.goto(`/w/${slug}/projects/reports/board`);
    await expect(reporter.locator(".board-card")).toHaveCount(1);
    await expect(reporter.getByRole("button", { name: `Board actions for issue !${own.number}`, exact: true })).toBeEnabled();
    await reporter.getByRole("button", { name: "Manage lanes", exact: true }).click();
    await expect(reporter.getByLabel("Create a new lane")).toBeDisabled();
    await expect(reporter.getByRole("button", { name: "Save board", exact: true })).toHaveCount(0);
    await reporter.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

    // Permission combination has all-project scope, including future projects.
    await page.reload();
    await page.getByRole("button", { name: "Edit permissions for Reporter", exact: true }).click();
    await dialog.getByLabel("Default permissions", { exact: true }).selectOption("read+create-issue");
    await dialog.getByLabel("Permissions for Reporting project", { exact: true }).selectOption("");
    await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await page.request.post("/api/projects", { headers, data: { name: "Future project", slug: "future" } })).ok()).toBeTruthy();
    await reporter.goto(`/w/${slug}/projects/reports/board`);
    await expect(reporter.locator(".board-card")).toHaveCount(2);
    await expect(reporter.getByLabel(`Select issue !${other.number}`, { exact: true })).toBeDisabled();
    await expect(reporter.getByLabel(`Select issue !${own.number}`, { exact: true })).toBeEnabled();
    await reporter.getByRole("button", { name: "Select visible issues", exact: true }).click();
    await expect(reporter.locator(".issue-selection-count")).toHaveText("1 selected");
    await reporter.goto(`/w/${slug}/issues/${other.number}`);
    await expect(reporter.locator(".issue-read-only")).toContainText("Other author issue");
    await expect(reporter.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await expect(reporter.getByRole("button", { name: "Post comment", exact: true })).toHaveCount(0);
    await reporter.goto("/new");
    await expect(reporter.getByRole("combobox", { name: "Project", exact: true })).toContainText("Future project");

    // A retained Read grant keeps author editing, but does not allow new issues.
    expect((await page.request.patch(`/api/workspaces/${slug}/members/${member.id}`, { data: { defaultAccess: "read", projectAccess: [] } })).ok()).toBeTruthy();
    await reporter.goto(`/w/${slug}/issues/${own.number}`);
    await expect(reporter.getByRole("button", { name: "Post comment", exact: true })).toBeVisible();
    await expect(reporter.getByRole("button", { name: "Create issue", exact: true })).toHaveCount(0);
    await reporter.getByRole("button", { name: "Change project", exact: true }).click();
    await expect(reporter.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(project.id);
    await expect(reporter.getByRole("combobox", { name: "Project", exact: true })).toContainText("Reporting project");

    // Full is not a bypass for the creator-only lane policy.
    expect((await page.request.patch(`/api/workspaces/${slug}/members/${member.id}`, { data: { defaultAccess: "full", projectAccess: [] } })).ok()).toBeTruthy();
    await reporter.goto(`/w/${slug}/projects/reports/board`);
    await reporter.getByRole("button", { name: "Manage lanes", exact: true }).click();
    await expect(reporter.getByLabel("Create a new lane")).toBeDisabled();
    await reporter.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.goto(`/w/${slug}/projects/reports/board`);
    await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
    await expect(page.getByLabel("Create a new lane")).toBeEnabled();
    await page.getByLabel("Create a new lane").fill("Review");
    await page.getByRole("button", { name: "Create lane", exact: true }).click();
    await page.getByRole("button", { name: "Save board", exact: true }).click();
    await expect(page.locator(".lane-name").filter({ hasText: "Review" })).toBeVisible();
    expect((await (await page.request.get(`/api/projects/${project.slug}`, { headers })).json()).project.creatorId).not.toBe(member.id);
  } finally { await context.close(); }
});
