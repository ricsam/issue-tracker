import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

const dialog = (page: Page) => page.getByRole("dialog", { name: "Create issue", exact: true });
const rows = (page: Page) => page.locator(".issue-row");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Issue details", exact: true });
async function createDraft(page: Page, body: string) {
  await dialog(page).getByRole("textbox", { name: "Issue", exact: true }).fill(body);
  const response = page.waitForResponse((result) => result.request().method() === "POST" && /\/api\/(?:projects\/[^/]+\/)?issues$/.test(new URL(result.url()).pathname));
  await dialog(page).getByRole("button", { name: "Create issue", exact: true }).click();
  const saved = await response;
  expect(saved.ok()).toBeTruthy();
  const { issue } = await saved.json();
  const href = `/issues/${issue.id}`;
  await expect(dialog(page).getByRole("link", { name: "View issue" })).toHaveAttribute("href", href);
  await expect(dialog(page).getByRole("textbox", { name: "Issue", exact: true })).toBeEmpty();
  return href;
}
async function filterProject(page: Page, value: string) {
  await page.getByRole("button", { name: /^Project filters/ }).click();
  const filter = page.getByRole("dialog", { name: "Project filters", exact: true });
  await filter.getByRole("combobox", { name: "Filter by project" }).selectOption(value);
  await filter.getByRole("button", { name: "Done", exact: true }).click();
}
async function project(page: Page, origin: string, name: string) {
  const response = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).project;
}

test("sidebar creation works without a project, switches projects, and unlinked details remain editable", async ({ page, baseURL }) => {
  const marker = `Global ${randomUUID()}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: "Create issue (Alt+N)", exact: true }).click();
  await expect(dialog(page).getByRole("combobox", { name: "Project", exact: true })).toHaveValue("");
  await expect(dialog(page).getByRole("textbox", { name: "Issue", exact: true })).toBeFocused();
  const href = await createDraft(page, `${marker} unlinked #global`);
  const result = await (await page.request.get(`/api${href}`)).json();
  expect(result.issue.projectId).toBeNull();
  await dialog(page).getByRole("link", { name: "View issue" }).click();
  await expect(page).toHaveURL(href);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "All issues" })).toHaveAttribute("href", "/issues");
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill(`${marker} edited #global`);
  await editor.press("Control+s");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close issue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reopen issue" })).toBeVisible();
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await page.locator(".comments [contenteditable=true]").fill("Unlinked discussion");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("Unlinked discussion", { exact: true })).toBeVisible();

  const p = await project(page, baseURL!, `${marker} project`);
  await page.goto("/issues");
  await expect(page.getByRole("heading", { name: "All issues", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+n");
  await expect(dialog(page).getByRole("combobox", { name: "Project", exact: true })).toHaveValue("");
  await dialog(page).getByRole("combobox", { name: "Project", exact: true }).selectOption(p.id);
  const linked = await createDraft(page, `${marker} linked`);
  expect((await (await page.request.get(`/api${linked}`)).json()).issue.projectId).toBe(p.id);
  // The selection persists for consecutive drafts, but can be cleared.
  await expect(dialog(page).getByRole("combobox", { name: "Project", exact: true })).toHaveValue(p.id);
  await dialog(page).getByRole("combobox", { name: "Project", exact: true }).selectOption("");
  const second = await createDraft(page, `${marker} second unlinked`);
  expect((await (await page.request.get(`/api${second}`)).json()).issue.projectId).toBeNull();
  await dialog(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(3);
  await page.screenshot({ path: "test-results/all-issues-desktop.png" });
  await filterProject(page, "none");
  await expect(rows(page)).toHaveCount(2);
  await filterProject(page, p.id);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("linked");
  await page.getByRole("button", { name: "Clear column filters" }).click();
  await expect(rows(page)).toHaveCount(3);
});

test("project creation can become unlinked without leaking into the project list or losing a detail draft", async ({ page, baseURL }) => {
  const marker = `Local ${randomUUID()}`;
  const p = await project(page, baseURL!, marker);
  const { issue } = await (await page.request.post(`/api/projects/${p.slug}/issues`, { headers: { Origin: baseURL! }, data: { body: `${marker} original` } })).json();
  await page.goto(`/projects/${p.slug}`);
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  await sidebar(page).locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await sidebar(page).getByRole("textbox", { name: "Issue", exact: true }).fill("Unsaved local draft");
  await page.getByRole("button", { name: "Create issue (Alt+N)", exact: true }).click();
  await expect(dialog(page).getByRole("combobox", { name: "Project", exact: true })).toHaveValue(p.id);
  await dialog(page).getByRole("combobox", { name: "Project", exact: true }).selectOption("");
  const href = await createDraft(page, `${marker} without project`);
  page.once("dialog", async (prompt) => { expect(prompt.message()).toContain("Discard unsaved"); await prompt.dismiss(); });
  await dialog(page).getByRole("link", { name: "View issue" }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(sidebar(page).getByRole("textbox", { name: "Issue", exact: true })).toContainText("Unsaved local draft");
  await page.goto("/issues");
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(2);
  await page.locator(`a.issue-link[href="${href}"]`).click();
  await expect(sidebar(page).locator(".detail-form .editor-preview")).toContainText("without project");
});

test("all issues combines project filtering and bulk actions while archived rows stay read-only", async ({ page, baseURL }) => {
  const marker = `Filter ${randomUUID()}`;
  const headers = { Origin: baseURL! };
  const p = await project(page, baseURL!, `${marker} active`);
  const archived = await project(page, baseURL!, `${marker} archived`);
  const seeded = [];
  for (const [body, projectId] of [[`${marker} linked`, p.id], [`${marker} unlinked`, null], [`${marker} archived`, archived.id]] as const) {
    const response = await page.request.post("/api/issues", { headers, data: { body, projectId } });
    expect(response.ok()).toBeTruthy();
    seeded.push((await response.json()).issue);
  }
  expect((await page.request.patch(`/api/projects/${archived.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.goto("/issues");
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: `${marker} archived` }).getByRole("checkbox")).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).check();
  await expect(page.locator(".issue-selection-count")).toHaveText("2 selected");
  await page.getByRole("button", { name: "Tag selected issues" }).click();
  const tagDialog = page.getByRole("dialog", { name: "Tag teammates" });
  await tagDialog.getByRole("checkbox", { name: /Alex Morgan/ }).check();
  await tagDialog.getByRole("button", { name: "Add mentions" }).click();
  await expect(tagDialog).toBeHidden();
  await page.getByRole("group", { name: "Selected issue actions" }).getByRole("button", { name: "Add tags", exact: true }).click();
  const labels = page.getByRole("dialog", { name: "Add tags", exact: true });
  await labels.getByRole("textbox", { name: "New tags" }).fill("#workspace");
  await labels.getByRole("button", { name: "Add tags", exact: true }).click();
  await expect(labels).toBeHidden();
  for (const issue of seeded.slice(0, 2)) {
    const saved = (await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue;
    expect(saved.labels).toContain("workspace");
    expect(saved.taggedUserIds).toHaveLength(1);
  }
  await filterProject(page, "none");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator(".issue-selection-count")).toHaveText("1 selected");
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(rows(page)).toHaveCount(0);
  await page.getByRole("link", { name: /^Closed \d/ }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("unlinked");
  await page.getByRole("button", { name: "Clear column filters" }).click();
  await page.getByRole("link", { name: /^Open \d/ }).click();
  await filterProject(page, archived.id);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).getByRole("link", { name: /#\d+ Filter/ }).click();
  await expect(sidebar(page).getByText(/belongs to an archived project/)).toBeVisible();
  await page.keyboard.press("Alt+n");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("combobox", { name: "Project", exact: true }).locator(`option[value="${archived.id}"]`)).toHaveCount(0);
});

test("creation during a delayed list load survives a stale response without duplicates", async ({ page }) => {
  const marker = `Loading ${randomUUID()}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void;
  const fetched = new Promise<void>((resolve) => { captured = resolve; });
  let first = true;
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "GET" || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  let href = "";
  try {
    await page.goto("/issues");
    await fetched;
    await page.keyboard.press("Alt+n");
    href = await createDraft(page, marker);
    await dialog(page).getByRole("button", { name: "Done", exact: true }).click();
  } finally { release(); }
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator("a.issue-link")).toHaveAttribute("href", href);
  await page.reload();
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(1);
});

test("mobile sidebar creation and All issues preserve navigation and keep the table horizontally scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/projects");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Create issue (Alt+N)", exact: true }).click();
  const marker = `Mobile ${randomUUID()}`;
  const href = await createDraft(page, marker);
  await dialog(page).getByRole("link", { name: "View issue" }).click();
  await expect(page).toHaveURL(href);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "All issues", exact: true }).click();
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(rows(page)).toHaveCount(1);
  const scroller = page.getByRole("region", { name: "Scrollable issues table" });
  expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await filterProject(page, "none");
  await page.screenshot({ path: "test-results/all-issues-mobile.png" });
  await rows(page).getByRole("link", { name: new RegExp(marker) }).click();
  await expect(page).toHaveURL(href);
});
