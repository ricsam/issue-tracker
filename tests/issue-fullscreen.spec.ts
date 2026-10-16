import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string, board: boolean) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Expand ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Fullscreen issue" } })).json();
  await page.request.put(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [issue.id], lane: "todo" } });
  const path = `/w/default/projects/${project.slug}${board ? "/board" : ""}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(path);
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("Fullscreen");
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  await expect(page.locator(".detail-form .editor-preview")).toContainText("Fullscreen issue");
  return { project, issue, path, headers };
}
const panel = (page: Page) => page.locator("#issue-detail-sidebar");

for (const board of [false, true]) {
  test(`${board ? "board" : "list"}: fullscreen is reversible without navigation, remounts or draft loss`, async ({ page, baseURL }) => {
    const { issue, path } = await seed(page, baseURL!, board);
    const detail = panel(page);
    const initialWidth = (await detail.boundingBox())!.width;
    const form = detail.locator(".detail-form");
    await form.getByRole("button", { name: "Markdown", exact: true }).click();
    const source = form.getByLabel("Markdown source");
    await source.fill("Keep this fullscreen draft");
    const originalEditor = await source.elementHandle();
    const comment = detail.locator(".comments [contenteditable=true]");
    await comment.fill("Unsent fullscreen comment");
    const originalComment = await comment.elementHandle();
    const confirmations: string[] = [];
    page.on("dialog", async (dialog) => { confirmations.push(dialog.message()); await dialog.dismiss(); });
    await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Issue details", exact: true });
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(page).toHaveURL(path);
    const box = (await modal.boundingBox())!;
    expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 1000 });
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBeTruthy();
    expect(await originalComment!.evaluate((node) => node.isConnected)).toBeTruthy();
    await expect(source).toHaveValue("Keep this fullscreen draft");
    await expect(comment).toContainText("Unsent fullscreen comment");
    // Background navigation/collection are absent from the accessibility tree.
    await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveCount(0);
    await page.locator(".project-issues-content input[aria-label='Search issues']").evaluate((node: HTMLInputElement) => node.focus());
    expect(await detail.evaluate((node) => node.contains(document.activeElement))).toBeTruthy();
    // Nested pickers must work and consume their own Escape before the modal does.
    await modal.getByRole("button", { name: "Change board lane", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Board lane", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Change board lane", exact: true }).click();
    await page.getByRole("combobox", { name: "Board lane", exact: true }).selectOption("done");
    await expect(modal.getByRole("button", { name: "Change board lane", exact: true })).toContainText("Done");
    await expect(source).toHaveValue("Keep this fullscreen draft");
    // Close still protects drafts; collapse is always non-destructive.
    await modal.getByRole("button", { name: "Close issue details" }).click();
    await expect(modal).toBeVisible();
    expect(confirmations).toHaveLength(1);
    await modal.getByRole("button", { name: "Collapse to sidebar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(path);
    expect((await detail.boundingBox())!.width).toBe(initialWidth);
    await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("Fullscreen");
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBeTruthy();
    await expect(comment).toContainText("Unsent fullscreen comment");
    await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(detail.getByRole("button", { name: "Expand issue", exact: true })).toBeFocused();
    expect(confirmations).toHaveLength(1);
    await source.fill("Saved after fullscreen");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.body).toBe("Saved after fullscreen");
  });
}

test("linked identifier and share use canonical URL, support new tabs and clipboard failure", async ({ page, baseURL, context }) => {
  const { issue, path } = await seed(page, baseURL!, false);
  const detail = panel(page);
  const link = detail.getByRole("link", { name: `ISSUE !${issue.number}`, exact: true });
  await expect(link).toHaveAttribute("href", `/w/default/issues/${issue.number}`);
  const popup = context.waitForEvent("page");
  await link.click({ modifiers: ["ControlOrMeta"] });
  const tab = await popup;
  await expect(tab).toHaveURL(`/w/default/issues/${issue.number}`);
  await tab.close();
  await expect(page).toHaveURL(path);
  await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
  await detail.getByRole("button", { name: "Share issue", exact: true }).click();
  const url = `${baseURL}/w/default/issues/${issue.number}`;
  await expect(page.getByRole("textbox", { name: "Issue link", exact: true })).toHaveValue(url);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Issue details", exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("denied")) }); });
  await detail.getByRole("button", { name: "Share issue", exact: true }).click();
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Select and copy the link above");
  await expect(page.getByRole("textbox", { name: "Issue link", exact: true })).toHaveValue(url);
  await page.keyboard.press("Escape");
  // Fullscreen remains usable across a narrow resize without changing the route.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "Issue details", exact: true })).toBeVisible();
  await expect(page).toHaveURL(path);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/issue-fullscreen-mobile.png" });
  await detail.getByRole("button", { name: "Collapse to sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Issue details", exact: true })).toBeVisible();
  await expect(page).toHaveURL(path);
  await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Issue details", exact: true })).toBeVisible();
});

test("scroll and focus stay contained and collapse remains reachable through discussion", async ({ page, baseURL }) => {
  const { path } = await seed(page, baseURL!, false);
  const detail = panel(page);
  await detail.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await detail.getByLabel("Markdown source").fill(Array.from({ length: 90 }, (_, i) => `Paragraph ${i}`).join("\n\n"));
  await detail.locator(".detail-form").getByRole("button", { name: "Preview", exact: true }).click();
  await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
  const scroll = detail.locator(".issue-detail-scroll");
  await scroll.evaluate((node) => { node.scrollTop = 800; });
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800);
  await expect(detail.getByRole("button", { name: "Collapse to sidebar" })).toBeInViewport();
  await detail.getByRole("button", { name: "Collapse to sidebar" }).click();
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800);
  await detail.getByRole("button", { name: "Expand issue", exact: true }).click();
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800);
  await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(detail.getByRole("button", { name: "Collapse to sidebar" })).toBeInViewport();
  // Loop backwards from the first tabbable element, then forwards from the last.
  await detail.locator(".issue-permalink").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await detail.evaluate((node) => node.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press("Tab");
  await expect(detail.locator(".issue-permalink")).toBeFocused();
  await detail.getByRole("button", { name: "Collapse to sidebar" }).click();
  await expect(page).toHaveURL(path);
});

test("condensed sidebar header uses two rows and fits the resized panel", async ({ page, baseURL }) => {
  const { project, headers } = await seed(page, baseURL!, false);
  await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { name: "Issue tracker" } });
  await page.reload();
  await page.locator("a[data-issue-id]").first().click();
  const resizer = page.getByRole("separator", { name: "Resize issue details" });
  await resizer.focus();
  await resizer.press("End");
  const header = panel(page).locator(".issue-detail-header");
  const actions = panel(page).locator(".detail-heading");
  expect((await header.boundingBox())!.height).toBeLessThan(65);
  expect((await actions.boundingBox())!.height).toBeLessThan(45);
  await expect(header).toContainText("Issue tracker");
  await expect(header).toContainText("Todo");
  await expect(panel(page).getByRole("heading", { name: "Issue details", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/issue-header-sidebar.png" });
  await panel(page).getByRole("button", { name: "Expand issue", exact: true }).click();
  await page.screenshot({ path: "test-results/issue-fullscreen-desktop.png" });
});
