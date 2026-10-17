import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

test.use({ extraHTTPHeaders: { Origin: `http://127.0.0.1:${process.env.E2E_PORT || 4179}` } });
// Match the shared browser suite's initial administrator, so this file works
// both alone and after the existing regression specs on the same test server.
const password = "local-browser-test-password";
const adminEmail = "alex@example.test";
async function loginAdmin(request: APIRequestContext) {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(`/api/auth/${setupRequired ? "setup" : "login"}`, { data: { email: adminEmail, password, ...(setupRequired ? { name: "Alex Morgan" } : {}) } });
  expect(response.ok()).toBeTruthy();
}
async function createWorkspace(request: APIRequestContext, slug: string, visibility = "hidden") {
  const response = await request.post("/api/workspaces", { data: { name: slug, slug, visibility } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).workspace;
}
async function createProject(request: APIRequestContext, workspace: string, slug: string, name = slug) {
  const response = await request.post("/api/projects", { headers: { "X-Workspace-Slug": workspace }, data: { name, slug } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).project;
}
async function createIssue(request: APIRequestContext, workspace: string, project: string, body: string) {
  const response = await request.post(`/api/projects/${project}/issues`, { headers: { "X-Workspace-Slug": workspace }, data: { body } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).issue;
}

test("workspace selector persists, isolates lists, numbers, links, and standalone creation", async ({ page }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36);
  const alpha = `alpha-${tag}`, beta = `beta-${tag}`;
  await createWorkspace(page.request, alpha);
  await createWorkspace(page.request, beta);
  await createProject(page.request, alpha, "shared", "Alpha project");
  await createProject(page.request, beta, "shared", "Beta project");
  const a = await createIssue(page.request, alpha, "shared", "Alpha issue with !2");
  await createIssue(page.request, alpha, "shared", "Alpha second issue");
  const b = await createIssue(page.request, beta, "shared", "Beta first issue");
  expect(a.number).toBe(1); expect(b.number).toBe(1); expect(a.id).not.toBe(b.id);
  await page.goto(`/w/${alpha}/projects`);
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(alpha);
  await expect(page.locator(".project-card")).toContainText("Alpha project");
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(beta);
  await expect(page).toHaveURL(`/w/${beta}/projects`);
  await expect(page.locator(".project-card")).toContainText("Beta project");
  await expect(page.getByText("Alpha project", { exact: true })).toHaveCount(0);
  await page.goto("/");
  await expect(page).toHaveURL(`/w/${beta}/projects`);
  await page.getByRole("link", { name: "All issues", exact: true }).click();
  await expect(page.locator("a.issue-link")).toHaveAttribute("href", `/w/${beta}/issues/1`);
  await expect(page.locator("a.issue-link")).toContainText("Beta first issue");
  await page.goto(`/w/${alpha}/issues/1`);
  await expect(page.locator(".issue-permalink")).toHaveText("ISSUE !1");
  await expect(page.locator("a.issue-reference-chip").filter({ hasText: "!2" })).toHaveAttribute("href", `/w/${alpha}/issues/2`);
  await page.getByRole("button", { name: "Share issue", exact: true }).click();
  await expect(page.getByLabel("Issue link", { exact: true })).toHaveValue(new RegExp(`/w/${alpha}/issues/1$`));
  await page.goto("/new");
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(beta);
  await expect(page).toHaveURL("/new");
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption({ label: "Beta project" });
  await page.getByRole("textbox", { name: "Issue", exact: true }).fill("Created in beta composer");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(page.getByRole("link", { name: "View issue", exact: true })).toHaveAttribute("href", `/w/${beta}/issues/2`);
  const result = await (await page.request.get("/api/issues", { headers: { "X-Workspace-Slug": alpha } })).json();
  expect(result.issues.some((issue: { title: string }) => issue.title === "Created in beta composer")).toBe(false);
});

test("workspace management invitations, overrides, read-only screens, discovery, and policy", async ({ page, browser, baseURL }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36);
  const slug = `team-${tag}`, publicSlug = `listed-${tag}`, email = `reader-${tag}@example.test`;
  await createWorkspace(page.request, slug);
  await createWorkspace(page.request, publicSlug, "public");
  const project = await createProject(page.request, slug, "readonly", "Read project");
  await createProject(page.request, slug, "editable", "Full project");
  await createIssue(page.request, slug, "readonly", "Read-only issue body");
  const account = await page.request.post("/api/admin/users", { data: { name: "Workspace Reader", email, password } });
  expect(account.ok()).toBeTruthy();
  await page.goto(`/w/${slug}/settings`);
  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByLabel("Default permissions", { exact: true }).selectOption("full");
  await dialog.getByLabel("Permissions for Read project", { exact: true }).selectOption("read");
  await dialog.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  if (process.env.R5D_ROOT && process.env.R5D_SESSION_ID) {
    const artifacts = join(process.env.R5D_ROOT, "artifacts", process.env.R5D_SESSION_ID);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "workspace-management-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.locator(".sidebar").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(slug);
    await page.screenshot({ path: join(artifacts, "workspace-navigation-mobile.png") });
    await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect(page.locator(".nav-backdrop")).toHaveCount(0);
    await page.locator(".sidebar").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(artifacts, "workspace-management-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL! } });
  try {
    const reader = await context.newPage();
    const login = await reader.request.post("/api/auth/login", { data: { email, password } });
    expect(login.ok()).toBeTruthy();
    await createProject(page.request, slug, "future", "Future project");
    await reader.goto(`/w/${slug}/projects`);
    await expect(reader.locator(".project-card").filter({ hasText: "Future project" })).toBeVisible();
    await expect(reader.getByRole("combobox", { name: "Workspace", exact: true })).not.toContainText(publicSlug);
    await reader.goto(`/w/${slug}/issues/1`);
    await expect(reader.locator(".issue-read-only")).toContainText("Read-only issue body");
    await expect(reader.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Post comment", exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Change project", exact: true })).toBeDisabled();
    await reader.goto(`/w/${slug}/projects/readonly/board`);
    await expect(reader.getByRole("button", { name: "Add issues", exact: true })).toBeDisabled();
    await reader.goto("/new");
    await expect(reader.getByRole("combobox", { name: "Project", exact: true })).not.toContainText("Read project");
    await expect(reader.getByRole("combobox", { name: "Project", exact: true })).toContainText("Full project");
    await expect(reader.getByRole("combobox", { name: "Project", exact: true })).toContainText("Future project");
    await reader.goto("/workspaces");
    const discoverable = reader.locator(".workspace-card").filter({ hasText: publicSlug });
    await expect(discoverable).toContainText("Invitation required");
    await expect(discoverable.getByRole("link", { name: "Open workspace" })).toHaveCount(0);
    await reader.goto(`/w/${publicSlug}/projects`);
    await expect(reader.getByRole("heading", { name: "Workspace unavailable" })).toBeVisible();
    await expect(reader.getByText("Full project", { exact: true })).toHaveCount(0);
    await reader.evaluate(() => { history.pushState({}, "", "/w/%E0%A4%A/projects"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(reader.getByRole("heading", { name: "Workspace unavailable" })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Edit permissions for Workspace Reader", exact: true }).click();
    await dialog.getByLabel("Default permissions", { exact: true }).selectOption("none");
    await dialog.getByLabel("Permissions for Read project", { exact: true }).selectOption("full");
    await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await reader.goto(`/w/${slug}/projects`);
    await expect(reader.locator(".project-card")).toHaveCount(1);
    await expect(reader.locator(".project-card")).toContainText("Read project");
    await reader.goto("/new");
    await expect(reader.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(project.id);
    await expect(reader.getByRole("combobox", { name: "Project", exact: true })).not.toContainText("No project");
  } finally { await context.close(); }
  await page.goto("/admin/workspaces");
  await expect(page.getByRole("heading", { name: "All workspaces", exact: true })).toBeVisible();
  await page.getByLabel("Allow users to create workspaces").check();
  await page.getByRole("button", { name: "Save creation policy", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Workspace creation policy updated" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Allow users to create workspaces")).toBeChecked();
});

test("empty memberships never choose discoverable workspace; creating establishes admin membership", async ({ page, browser, baseURL }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36), email = `empty-${tag}@example.test`;
  await page.request.patch("/api/admin/workspace-settings", { data: { allowUserWorkspaceCreation: true } });
  const result = await (await page.request.post("/api/admin/users", { data: { name: "New member", email, password } })).json();
  await page.request.delete(`/api/workspaces/default/members/${result.user.id}`);
  await createWorkspace(page.request, `discover-${tag}`, "public");
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL! } });
  try {
    const member = await context.newPage();
    await member.request.post("/api/auth/login", { data: { email, password } });
    await member.goto("/");
    await expect(member).toHaveURL("/workspaces");
    await expect(member.getByRole("heading", { name: "No workspace memberships yet" })).toBeVisible();
    await expect(member.getByRole("combobox", { name: "Workspace", exact: true })).toBeDisabled();
    await member.getByRole("button", { name: "Create workspace", exact: true }).click();
    const dialog = member.getByRole("dialog");
    await dialog.getByLabel("Workspace name").fill("My own workspace");
    await dialog.getByLabel("Workspace slug").fill(`own-${tag}`);
    await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await member.goto(`/w/own-${tag}/settings`);
    await expect(member.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
    await expect(member.getByRole("button", { name: "Invite member", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("late old-workspace requests cannot populate a new scope; explicit links resolve target numbers", async ({ page }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36), alpha = `race-a-${tag}`, beta = `race-b-${tag}`;
  await createWorkspace(page.request, alpha); await createWorkspace(page.request, beta);
  await createProject(page.request, alpha, "race", "Race alpha project");
  await createProject(page.request, beta, "race", "Race beta project");
  await createIssue(page.request, alpha, "race", `Alpha source [cross-workspace reference](/w/${beta}/issues/1)`);
  await createIssue(page.request, beta, "race", "Beta target issue");
  await page.goto(`/w/${alpha}/projects`);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/issues", async route => {
    if (route.request().headers()["x-workspace-slug"] !== alpha) { await route.continue(); return; }
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("link", { name: "All issues", exact: true }).click();
  await ready;
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(beta);
  await expect(page).toHaveURL(`/w/${beta}/projects`);
  release();
  await expect(page.locator(".project-card")).toContainText("Race beta project");
  await page.getByRole("link", { name: "All issues", exact: true }).click();
  await expect(page.locator("a.issue-link")).toContainText("Beta target issue");
  await expect(page.locator("a.issue-link")).not.toContainText("Alpha source");
  await page.goto(`/w/${alpha}/issues/1`);
  await page.getByRole("link", { name: "cross-workspace reference", exact: true }).click();
  await expect(page).toHaveURL(`/w/${beta}/issues/1`);
  await expect(page.locator(".detail-form .markdown-content:visible")).toContainText("Beta target issue");
});

test("legacy permission changes require confirmation while no-op saves retain protection", async ({ page }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36), email = `legacy-${tag}@example.test`;
  const account = await (await page.request.post("/api/admin/users", { data: { name: `Legacy member ${tag}`, email, password } })).json();
  await page.goto("/w/default/settings");
  await page.getByRole("button", { name: `Edit permissions for Legacy member ${tag}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/This member uses legacy private-project protections/)).toBeVisible();
  const noOp = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith(`/members/${account.user.id}`));
  await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
  expect((await noOp).postDataJSON().convertLegacyAccess).toBeUndefined();
  await expect(dialog).toHaveCount(0);
  const before = await (await page.request.get("/api/workspaces/default/members")).json();
  expect(before.members.find((member: { userId: string }) => member.userId === account.user.id).legacyAccess).toBe(true);
  await page.getByRole("button", { name: `Edit permissions for Legacy member ${tag}`, exact: true }).click();
  await dialog.getByLabel("Default permissions", { exact: true }).selectOption("read");
  await expect(dialog.getByRole("button", { name: "Save permissions", exact: true })).toBeDisabled();
  await dialog.getByLabel("I understand this replaces legacy private-project protections").check();
  const changed = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith(`/members/${account.user.id}`));
  await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
  expect((await changed).postDataJSON().convertLegacyAccess).toBe(true);
  await expect(dialog).toHaveCount(0);
  const after = await (await page.request.get("/api/workspaces/default/members")).json();
  expect(after.members.find((member: { userId: string }) => member.userId === account.user.id).legacyAccess).toBe(false);
});

test("workspace switch confirms unsaved detail and composer drafts", async ({ page }) => {
  await loginAdmin(page.request);
  const tag = Date.now().toString(36), alpha = `draft-a-${tag}`, beta = `draft-b-${tag}`;
  await createWorkspace(page.request, alpha); await createWorkspace(page.request, beta);
  await createProject(page.request, alpha, "draft");
  await createIssue(page.request, alpha, "draft", "Original draft body");
  await page.goto(`/w/${alpha}/issues/1`);
  await page.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByLabel("Markdown source").first().fill("Unsaved detail changes");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(beta);
  await expect(page).toHaveURL(`/w/${alpha}/issues/1`);
  await expect(page.getByLabel("Markdown source").first()).toHaveValue("Unsaved detail changes");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(beta);
  await expect(page).toHaveURL(`/w/${beta}/projects`);
  await page.goto("/new");
  await page.getByRole("textbox", { name: "Issue", exact: true }).fill("Composer draft");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(alpha);
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(beta);
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toContainText("Composer draft");
});
