import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(session.cookies);
  // Deterministic clipboard boundary, including denied/unavailable browser cases.
  await context.addInitScript(() => {
    Object.assign(window, { copiedBodies: [], denyCopy: false });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (body: string) => {
        if ((window as any).denyCopy) throw new DOMException("Denied", "NotAllowedError");
        (window as any).copiedBodies.push(body);
      },
    } });
  });
});

test("copy uses current Markdown, excludes comments, never saves, and works archived and in sidebar", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Copy ${randomUUID()}` } })).json();
  const body = "## Canonical body\n\n**Bold** and `code` #tag\n\n- [ ] Task";
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body } })).json();
  await page.request.post(`/api/issues/${issue.id}/comments`, { headers, data: { body: "Do not copy this comment" } });
  await page.goto(`/issues/${issue.id}`);
  const copy = page.getByRole("button", { name: "Copy issue body", exact: true });
  await expect(page.locator(".detail-form .editor-topbar").getByRole("button", { name: "Copy issue body", exact: true })).toBeVisible();
  await expect(copy).toHaveCount(1);
  let writes = 0;
  page.on("request", request => { if (request.method() === "PATCH" && request.url().endsWith(`/api/issues/${issue.id}`)) writes++; });
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(await page.evaluate(() => (window as any).copiedBodies.at(-1))).toBe(body);
  await page.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  const draft = body + "\n\nUnsaved [link](https://example.com)";
  await page.locator(".detail-form").getByLabel("Markdown source").fill(draft);
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(await page.evaluate(() => (window as any).copiedBodies.at(-1))).toBe(draft);
  expect(writes).toBe(0);
  expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.body).toBe(body);

  await page.goto(`/projects/${project.slug}`);
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
  await sidebar.getByRole("button", { name: "Copy issue body" }).click();
  await expect(sidebar.getByRole("button", { name: "Copy issue body" })).toHaveText("Copied!");
  expect(await page.evaluate(() => (window as any).copiedBodies.at(-1))).toBe(body);
  await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } });
  await page.reload();
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  await expect(sidebar.getByText(/belongs to an archived project/)).toBeVisible();
  await sidebar.getByRole("button", { name: "Copy issue body" }).click();
  await expect(sidebar.getByRole("button", { name: "Copy issue body" })).toHaveText("Copied!");
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByText(/belongs to an archived project/)).toBeVisible();
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(await page.evaluate(() => (window as any).copiedBodies.at(-1))).toBe(body);
  expect(writes).toBe(0);
});

test("copy failures are actionable and retryable; creation never shows a copy action", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.getByRole("heading", { name: "All issues", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Created body");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "View issue" })).toBeVisible();
  const href = await dialog.getByRole("link", { name: "View issue" }).getAttribute("href");
  const { issue } = await (await page.request.get(`/api${href}`)).json();
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Next unsaved draft");
  await expect(dialog.getByRole("button", { name: "Copy issue body" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.goto(`/issues/${issue.id}`);
  const copy = page.locator(".editor-topbar").getByRole("button", { name: "Copy issue body" });
  await page.evaluate(() => { (window as any).denyCopy = true; });
  await copy.click();
  await expect(page.getByRole("alert")).toContainText("Could not copy");
  await page.evaluate(() => { (window as any).denyCopy = false; });
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(await page.evaluate(() => (window as any).copiedBodies.at(-1))).toBe(issue.body);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await copy.click();
  await expect(page.getByRole("alert").last()).toContainText("Could not copy");
});

test("styled button tooltips support hover, keyboard focus and Escape without changing focus or modal state", async ({ page }) => {
  await page.goto("/issues");
  const create = page.getByRole("button", { name: "Create issue (Alt+N)", exact: true });
  await create.hover();
  await expect(page.getByRole("tooltip")).toContainText("Create issue");
  await expect(create).not.toHaveAttribute("title");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await create.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(create).toHaveAttribute("aria-describedby", /.+/);
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  await create.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Tooltip draft");
  const submit = dialog.getByRole("button", { name: "Create issue", exact: true });
  await submit.focus();
  await expect(page.getByRole("tooltip")).toContainText("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(submit).toBeFocused();
  await expect(page.locator("button[title]")).toHaveCount(0);
  // Dismissing only the tooltip must not permanently disable dialog Escape.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("copy writes to the real browser clipboard and the mobile toolbar stays within the viewport", async ({ page, context, baseURL }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/issues");
  // Remove this file's own clipboard stub to exercise Chromium's real implementation.
  await page.evaluate(() => { delete (navigator as any).clipboard; });
  await expect(page.getByRole("heading", { name: "All issues", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Mobile clipboard issue");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "View issue" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy issue body", exact: true })).toHaveCount(0);
  const href = await dialog.getByRole("link", { name: "View issue" }).getAttribute("href");
  const { issue } = await (await page.request.get(`/api${href}`)).json();
  await dialog.getByRole("link", { name: "View issue" }).click();
  const copy = page.locator(".editor-topbar").getByRole("button", { name: "Copy issue body", exact: true });
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issue.body);
  const box = (await copy.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("mobile-copy-toolbar.png") });
});
