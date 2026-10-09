import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const modal = (page: Page) => page.getByRole("dialog");
const editor = (page: Page) => modal(page).getByRole("textbox", { name: "Issue", exact: true });
const submit = (page: Page) => modal(page).getByRole("button", { name: "Create issue", exact: true });
const status = (page: Page) => modal(page).getByRole("status");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Issue details", exact: true });

// Reuse one login across these isolated project cases; repeated logins would
// exhaust the real application's IP-based auth rate limit in the full suite.
let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const auth = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(auth.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

async function setup(page: Page, baseURL: string, board = false) {
  const headers = { Origin: baseURL };
  const response = await page.request.post("/api/projects", {
    headers, data: { name: `Creation ${randomUUID()}` },
  });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  const path = `/projects/${project.slug}`;
  await page.goto(path + (board ? "/board" : ""));
  await page.getByRole("button", { name: "Create issue", exact: true }).first().click();
  await expect(editor(page)).toBeFocused();
  await expect(modal(page)).not.toContainText("Write your issue in one place.");
  await expect(modal(page)).not.toContainText("Hashtags inside code are ignored.");
  await expect(modal(page)).not.toContainText("Place it on the board later");
  await expect(modal(page)).not.toContainText("Markdown supported.");
  return { path, endpoint: `/api/projects/${project.slug}/issues` };
}

async function expectReset(page: Page) {
  await expect(status(page)).toContainText(/Issue #\d+ created\./);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toBeEmpty();
  await expect(editor(page)).toBeFocused();
  await expect(modal(page).getByRole("button", { name: "Write", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(modal(page).getByRole("textbox", { name: "Labels", exact: true })).toHaveCount(0);
  await expect(modal(page).getByRole("list", { name: "Labels", exact: true })).toHaveCount(0);
  await expect(modal(page).getByLabel("Markdown source")).toHaveCount(0);
  await expect(modal(page).getByRole("button", { name: "Done", exact: true })).toBeVisible();
}

test("repeat creation resets preview, Markdown and undo history, then Done reveals the refreshed list", async ({ page, baseURL }) => {
  const { path } = await setup(page, baseURL!);
  await editor(page).fill("First creation");
  await modal(page).getByRole("button", { name: "Markdown", exact: true }).click();
  await modal(page).getByLabel("Markdown source").fill("# First creation\n\n**First body** #design #enhancement");
  await modal(page).getByRole("button", { name: "Preview", exact: true }).click();
  await submit(page).click();
  await expectReset(page);
  await expect(page).toHaveURL(path);
  await page.screenshot({ path: "test-results/issue-created-desktop.png" });
  const firstLink = await modal(page).getByRole("link", { name: "View issue" }).getAttribute("href");
  await editor(page).press("ControlOrMeta+z");
  await expect(editor(page)).toBeEmpty();
  await editor(page).fill("Second creation");
  await expect(status(page)).toContainText("Issue #1 created.");
  await modal(page).getByRole("button", { name: "Markdown", exact: true }).click();
  await submit(page).click();
  await expect(status(page)).toContainText("Issue #2 created.");
  await expectReset(page);
  await expect(modal(page).getByRole("link", { name: "View issue" })).not.toHaveAttribute("href", firstLink!);
  await modal(page).getByRole("button", { name: "Dismiss notification" }).click();
  await expect(status(page)).toBeEmpty();
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(modal(page)).toBeHidden();
  await expect(page.locator(".issue-row")).toHaveCount(2);
  await expect(page.locator(".issue-row").filter({ hasText: "First creation" })).toBeVisible();
  await expect(page.locator(".issue-row").filter({ hasText: "Second creation" })).toBeVisible();
});

for (const width of [1440, 1024, 1023, 390]) {
  for (const board of [false, true]) {
    test(`View issue ${width >= 1024 ? "opens the sidebar" : "navigates"} from the ${board ? "board" : "list"} at ${width}px`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 900 });
      const { path } = await setup(page, baseURL!, board);
      await editor(page).fill("Open created issue");
      await submit(page).click();
      await expectReset(page);
      const link = modal(page).getByRole("link", { name: "View issue" });
      const href = await link.getAttribute("href");
      const prompts: string[] = [];
      page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
      await link.click();
      await expect(modal(page)).toBeHidden();
      await expect(page.locator(".detail-form .editor-preview")).toContainText("Open created issue");
      if (width >= 1024) {
        await expect(page).toHaveURL(path + (board ? "/board" : ""));
        await expect(sidebar(page)).toBeVisible();
        await expect(sidebar(page)).toBeFocused();
        await expect(sidebar(page).getByRole("link", { name: "Open issue in full page" })).toHaveAttribute("href", href!);
        if (board) await expect(page.locator(".board-card")).toHaveCount(0);
        await sidebar(page).getByRole("button", { name: "Close issue details" }).click();
        await expect(sidebar(page)).toBeHidden();
        await expect(board ? page.locator(".project-issues-content") : page.locator(`.issue-link[href="${href}"]`)).toBeFocused();
      } else {
        await expect(page).toHaveURL(href!);
        await expect(sidebar(page)).toHaveCount(0);
      }
      expect(prompts).toEqual([]);
    });
  }
}

for (const mobile of [false, true]) {
  for (const draft of ["body", "hashtag"] as const) {
    test(`View issue confirms before discarding a ${draft} draft on ${mobile ? "mobile" : "desktop"}`, async ({ page, baseURL }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const { path } = await setup(page, baseURL!);
      await editor(page).fill("Saved issue");
      await submit(page).click();
      await expectReset(page);
      const field = editor(page);
      await field.fill(draft === "body" ? "Unsaved draft" : "#unsaved");
      const link = modal(page).getByRole("link", { name: "View issue" });
      const href = await link.getAttribute("href");
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toBe("Discard the new issue draft and view the created issue?");
        await dialog.dismiss();
      });
      await link.click();
      await expect(page).toHaveURL(path);
      await expect(field).toContainText(draft === "body" ? "Unsaved draft" : "#unsaved");
      page.once("dialog", async (dialog) => { await dialog.accept(); });
      await link.click();
      await expect(modal(page)).toBeHidden();
      await expect(page).toHaveURL(mobile ? href! : path);
      await expect(page.locator(".detail-form .editor-preview")).toContainText("Saved issue");
      if (!mobile) await expect(sidebar(page)).toBeVisible();
    });
  }
}

test("View issue preserves new-tab behavior and the current draft on desktop", async ({ page, baseURL }) => {
  const { path } = await setup(page, baseURL!);
  await editor(page).fill("Open in another tab");
  await submit(page).click();
  await expectReset(page);
  await editor(page).fill("Keep this draft");
  const link = modal(page).getByRole("link", { name: "View issue" });
  const href = await link.getAttribute("href");
  const popupPromise = page.context().waitForEvent("page");
  await link.click({ modifiers: ["ControlOrMeta"] });
  const popup = await popupPromise;
  try {
    await expect(popup).toHaveURL(href!);
    await expect(popup.locator(".detail-form .editor-preview")).toContainText("Open in another tab");
    await expect(page).toHaveURL(path);
    await expect(editor(page)).toContainText("Keep this draft");
    await expect(sidebar(page)).toHaveCount(0);
  } finally {
    await popup.close();
  }
});

test("View issue protects an existing sidebar draft before replacing it", async ({ page, baseURL }) => {
  const { path } = await setup(page, baseURL!);
  await editor(page).fill("Original issue");
  await submit(page).click();
  await expectReset(page);
  await modal(page).getByRole("link", { name: "View issue" }).click();
  await sidebar(page).locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await sidebar(page).getByRole("textbox", { name: "Issue", exact: true }).fill("Unsaved sidebar draft");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await editor(page).fill("Replacement issue");
  await submit(page).click();
  await expectReset(page);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Discard unsaved issue changes or comment?");
    await dialog.dismiss();
  });
  await modal(page).getByRole("link", { name: "View issue" }).click();
  await expect(modal(page)).toBeVisible();
  await expect(page.locator(".issue-detail-sidebar .detail-form [contenteditable=true]")).toContainText("Unsaved sidebar draft");
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await modal(page).getByRole("link", { name: "View issue" }).click();
  await expect(modal(page)).toBeHidden();
  await expect(page).toHaveURL(path);
  await expect(sidebar(page).locator(".detail-form .editor-preview")).toContainText("Replacement issue");
  await sidebar(page).getByRole("button", { name: "Close issue details" }).click();
  await expect(sidebar(page)).toBeHidden();
});

test("a rejected submission retains the entire draft and can be retried", async ({ page, baseURL }) => {
  const { endpoint } = await setup(page, baseURL!);
  await editor(page).fill("Retained issue #retry");
  await modal(page).getByRole("button", { name: "Markdown", exact: true }).click();
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, json: { error: "Creation deliberately failed" } });
    else await route.continue();
  });
  await submit(page).click();
  await expect(modal(page).getByText("Creation deliberately failed", { exact: true })).toBeVisible();
  await expect(modal(page).getByLabel("Markdown source")).toHaveValue(/Retained issue/);
  await expect(modal(page).getByLabel("Markdown source")).toHaveValue(/#retry/);
  await expect(status(page)).toBeEmpty();
  await page.unroute(`**${endpoint}`);
  await submit(page).click();
  await expectReset(page);
  await expect(status(page)).toContainText("Issue #1 created.");
});

test("a refresh failure after POST remains a committed creation, not a retryable draft", async ({ page, baseURL }) => {
  const { endpoint } = await setup(page, baseURL!);
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 500, json: { error: "Project refresh deliberately failed" } });
    else await route.continue();
  });
  await editor(page).fill("Committed despite refresh");
  await submit(page).click();
  await expectReset(page);
  await expect(modal(page).getByText("Project refresh deliberately failed")).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Project refresh deliberately failed");
  const response = await page.request.get(endpoint);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).issues).toHaveLength(1);
});

test("pending creation locks the draft and actions and only sends one request", async ({ page, baseURL }) => {
  const { path, endpoint } = await setup(page, baseURL!);
  await editor(page).fill("Already saved");
  await submit(page).click();
  await expectReset(page);
  await editor(page).fill("Slow creation");
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "POST") {
      requests++;
      await held;
    }
    await route.continue();
  });
  try {
    await submit(page).click();
    await expect(modal(page).getByRole("button", { name: "Creating…" })).toBeDisabled();
    await expect(modal(page).getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    await expect(modal(page).getByRole("link", { name: "View issue" })).toHaveAttribute("aria-disabled", "true");
    await expect(modal(page).locator("fieldset")).toHaveAttribute("inert", "");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(modal(page)).toBeVisible();
    await expect(page).toHaveURL(path);
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(status(page)).toContainText("Issue #2 created.");
  await expectReset(page);
  expect((await (await page.request.get(endpoint)).json()).issues).toHaveLength(2);
});

test("mobile board creation exposes actions without overflow and never adds board membership", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { path } = await setup(page, baseURL!, true);
  await editor(page).fill("Mobile board creation");
  await expect(submit(page)).toBeInViewport();
  await submit(page).click();
  await expectReset(page);
  await expect(page).toHaveURL(path + "/board");
  for (const action of [modal(page).getByRole("link", { name: "View issue" }), modal(page).getByRole("button", { name: "Done", exact: true }), modal(page).getByRole("button", { name: "Dismiss notification" })]) {
    await expect(action).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await modal(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/issue-created-mobile.png" });
  // Scrolling the fields must reveal hashtag chips without putting them under the actions.
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size);
    await editor(page).fill("Next draft #next-draft");
    const labels = editor(page).locator(".hashtag-chip");
    await labels.scrollIntoViewIfNeeded();
    // Chromium rounds scroll offsets to pixels; allow subpixel clipping of the
    // chip box (the footer bound below still ensures no overlap).
    await expect(labels).toBeInViewport({ ratio: 0.98 });
    const fieldBox = (await labels.boundingBox())!;
    const footerBox = (await modal(page).locator(".create-issue-footer").boundingBox())!;
    expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(footerBox.y + 1);
    await expect(modal(page).getByRole("link", { name: "View issue" })).toBeInViewport();
    expect(await modal(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    await editor(page).fill("");
  }
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Add issue #1:.*Mobile board creation/ })).toBeVisible();
});
