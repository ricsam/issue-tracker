import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function openComposer(page: Page, baseURL: string) {
  expect((await page.request.post("/api/auth/login", {
    headers: { Origin: baseURL }, data: { email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  await page.goto("/new");
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toBeVisible();
}

test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  if (setupRequired) expect((await request.post("/api/auth/setup", {
    headers: { Origin: baseURL! }, data: { name: "Alex Morgan", email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
});

test("/new retains local login, offers safe SSO return, and has no workspace shell", async ({ page }) => {
  await page.route("**/api/auth/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, oidc: { enabled: true, name: "SSO" } } });
  });
  await page.goto("/new");
  await expect(page.getByRole("link", { name: "Sign in with SSO" })).toHaveAttribute("href", "/api/auth/oidc/login?returnTo=%2Fnew");
  await page.getByLabel("Email address").fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("local-browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create issue" })).toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.locator(".sidebar, .app-shell, .topbar, .dialog-overlay, [role=dialog]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Cancel|Done)$/ })).toHaveCount(0);
  const workspace = page.getByRole("link", { name: "Open workspace" });
  await expect(workspace).toHaveAttribute("target", "_blank");
  await expect(workspace).toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("textbox", { name: "Issue", exact: true }).fill("Keep my draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toContainText("Keep my draft");
});

test("standalone creation continues, remembers selection, and fits tray and short viewports", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  await page.request.post("/api/auth/login", { headers, data: { email: "alex@example.test", password: "local-browser-test-password" } });
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Tray ${randomUUID()}` } })).json();
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/new");
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(project.id);
  await page.getByRole("combobox", { name: "Board lane", exact: true }).selectOption("todo");
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  for (const title of ["Tray first", "Tray second"]) {
    await editor.fill(title);
    await editor.press(title === "Tray first" ? "Control+Enter" : "Meta+s");
    await expect(editor).toBeEmpty();
    await expect(page.getByText(/created\. Ready for another\./)).toBeVisible();
    await expect(page.getByRole("link", { name: "View issue" })).toHaveAttribute("target", "_blank");
    await expect(page).toHaveURL(/\/new$/);
  }
  expect((await (await page.request.get(`/api/projects/${project.slug}/board`)).json()).board.cards.map((card: { lane: string }) => card.lane)).toEqual(["todo", "todo"]);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(project.id);
  await expect(page.getByRole("combobox", { name: "Board lane", exact: true })).toHaveValue("todo");
  for (const size of [{ width: 640, height: 800 }, { width: 640, height: 350 }, { width: 320, height: 400 }]) {
    await page.setViewportSize(size);
    const footer = await page.locator(".create-issue-footer").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(size.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeInViewport();
  }
});

test("expired standalone session returns to login at /new and can authenticate again", async ({ page, baseURL }) => {
  await openComposer(page, baseURL!);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Session expiry draft");
  // Revoke the real cookie, then let the composer encounter the API's real 401.
  expect((await page.request.post("/api/auth/logout", { headers: { Origin: baseURL! } })).ok()).toBeTruthy();
  const rejected = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
  const status = page.waitForResponse(response => response.url().endsWith("/api/auth/status"));
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  expect((await rejected).status()).toBe(401);
  expect((await (await status).json()).user).toBeNull();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(/\/new$/);
  await page.getByLabel("Email address").fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("local-browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
});

test("server create failure retains the standalone draft for a successful retry", async ({ page, baseURL }) => {
  await openComposer(page, baseURL!);
  await page.route("**/api/issues", route => route.request().method() === "POST"
    ? route.fulfill({ status: 500, json: { error: "Temporary creation failure" } }) : route.continue());
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Preserve this failed draft #retry");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary creation failure");
  await expect(editor).toContainText("Preserve this failed draft #retry");
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/new$/);
  await page.unroute("**/api/issues");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(editor).toBeEmpty();
  await expect(page.getByRole("link", { name: "View issue" })).toBeVisible();
});

test("workspace and created issue open new windows without losing the next draft", async ({ page, baseURL }) => {
  await openComposer(page, baseURL!);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Created before opening browser");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(editor).toBeEmpty();
  await editor.fill("The next draft must stay here");
  // View issue's notice is transient: exercise it first.
  for (const name of ["View issue", "Open workspace"]) {
    const link = page.getByRole("link", { name, exact: true });
    const href = await link.getAttribute("href");
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(`${baseURL}${href}`);
    await expect(popup.locator(".app-shell")).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(page).toHaveURL(/\/new$/);
    await expect(editor).toContainText("The next draft must stay here");
  }
});

test("standalone rich editor saves an explicit mention and an uploaded image", async ({ page, baseURL }) => {
  await openComposer(page, baseURL!);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Tray attachment and mention\n\nHello @alex");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await editor.press("Enter");
  const mention = editor.locator("[data-mention-user-id]");
  await expect(mention).toHaveCount(1);
  const userId = await mention.getAttribute("data-mention-user-id");
  await page.getByLabel("Upload attachments").setInputFiles({
    name: "tray-smoke.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("img", { name: "tray-smoke.png" })).toBeVisible();
  const saved = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const { issue } = await (await saved).json();
  expect(issue.taggedUserIds).toEqual([userId]);
  expect(issue.body).toContain("tray-smoke.png");
  const persisted = await (await page.request.get(`/api/issues/${issue.id}`)).json();
  expect(persisted.issue.body).toBe(issue.body);
  expect(persisted.issue.taggedUserIds).toEqual([userId]);
  await expect(editor).toBeEmpty();
  await expect(page.getByRole("img", { name: "tray-smoke.png" })).toHaveCount(0);
});
