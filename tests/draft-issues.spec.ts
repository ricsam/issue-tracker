import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { setTableState } from "./filter-helpers";

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

test("personal draft creation, persisted table filtering and publishing", async ({ page, baseURL }) => {
  const { project } = await (await page.request.post("/api/projects", {
    headers: { Origin: baseURL! }, data: { name: `Drafts ${randomUUID()}` },
  })).json();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create issue", exact: true });
  await expect(modal.getByLabel("Visibility", { exact: true })).toHaveValue("open");
  await modal.getByLabel("Board lane", { exact: true }).selectOption("todo");
  await modal.getByLabel("Visibility", { exact: true }).selectOption("draft");
  await expect(modal.getByText(/Only you can see this draft/)).toBeVisible();
  await expect(modal.getByLabel("Board lane", { exact: true })).toHaveCount(0);
  await modal.getByRole("textbox", { name: "Issue", exact: true }).fill("Private planning note");
  const created = page.waitForResponse(response => response.url().endsWith(`/projects/${project.slug}/issues`) && response.request().method() === "POST");
  await modal.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toEqual({ body: "Private planning note", state: "draft" });
  const { issue } = await response.json();
  expect(issue.state).toBe("draft");
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.locator(".issue-row").filter({ has: page.locator(`a[data-issue-id="${issue.id}"]`) });
  await expect(row).toHaveCount(0);
  await setTableState(page, "draft");
  await expect(row).toContainText("Draft");
  await page.reload();
  await expect(row).toContainText("Draft");
  await row.getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "Close selected issues", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Send to board", exact: true }).click();
  const send = page.getByRole("dialog", { name: "Send to board", exact: true });
  await expect(send.getByText(/Personal drafts will not be sent/)).toBeVisible();
  await expect(send.getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  await send.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.locator(".issue-link").click();
  const detail = page.locator(".detail-form");
  await expect(detail.getByText(/Only you can see this draft/)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Share issue", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Close issue", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Change board lane", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "Markdown", exact: true }).click();
  await detail.getByLabel("Markdown source").fill("Unsaved private edits");
  await expect(detail.getByRole("button", { name: "Publish issue", exact: true })).toBeDisabled();
  await detail.getByRole("button", { name: "Discard changes", exact: true }).click();
  await detail.getByRole("button", { name: "Publish issue", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Close issue", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Share issue", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.state).toBe("open");
  expect((await (await page.request.get(`/api/projects/${project.slug}/board`)).json()).board.cards).toEqual([]);
  await page.goto(`/projects/${project.slug}`);
  await setTableState(page, "open");
  await expect(row).toContainText("Private planning note");
});

test("standalone drafts omit remembered lanes and save even when board loading fails", async ({ page, baseURL }) => {
  const { project } = await (await page.request.post("/api/projects", {
    headers: { Origin: baseURL! }, data: { name: `Standalone drafts ${randomUUID()}` },
  })).json();
  await page.goto("/new");
  await page.getByLabel("Project", { exact: true }).selectOption(project.id);
  await page.getByLabel("Board lane", { exact: true }).selectOption("todo");
  await page.route(`**/api/projects/${project.slug}/board`, route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.reload();
  await page.getByRole("textbox", { name: "Issue", exact: true }).fill("Draft without board dependency");
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeDisabled();
  await page.getByLabel("Visibility", { exact: true }).selectOption("draft");
  const created = page.waitForResponse(response => response.url().endsWith(`/projects/${project.slug}/issues`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).not.toHaveProperty("lane");
  expect((await response.json()).issue.state).toBe("draft");
  await expect(page.getByRole("link", { name: "View issue" })).toHaveAttribute("target", "_blank");
  // Unlinked drafts use the same composer and the global create endpoint.
  await page.getByLabel("Project", { exact: true }).selectOption("");
  await page.getByRole("textbox", { name: "Issue", exact: true }).fill("Unlinked personal draft");
  const unlinked = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await (await unlinked).json()).issue).toMatchObject({ state: "draft", projectId: null });
});

test("member drafts are hidden from an admin's lists, reference picker and detail until published", async ({ page: admin, browser, baseURL }) => {
  const headers = { Origin: baseURL! };
  const email = `draft-owner-${randomUUID()}@example.test`;
  const password = "local-browser-test-password";
  expect((await admin.request.post("/api/admin/users", {
    headers, data: { name: "Draft owner", email, password },
  })).ok()).toBeTruthy();
  const memberContext = await browser.newContext({ baseURL });
  try {
    expect((await memberContext.request.post("/api/auth/login", { headers, data: { email, password } })).ok()).toBeTruthy();
    expect((await (await memberContext.request.get("/api/auth/status")).json()).user.role).toBe("member");
    const member = await memberContext.newPage();
    const title = `Personal secret ${randomUUID()}`;
    await member.goto("/new");
    await member.getByLabel("Project", { exact: true }).selectOption("");
    await member.getByLabel("Visibility", { exact: true }).selectOption("draft");
    await member.getByRole("textbox", { name: "Issue", exact: true }).fill(title);
    const created = member.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
    await member.getByRole("button", { name: "Save draft", exact: true }).click();
    const response = await created;
    expect(response.ok()).toBeTruthy();
    const { issue } = await response.json();

    // All issues preferences are independent of the project table's preferences.
    await member.goto("/issues");
    await setTableState(member, "draft");
    await member.getByRole("textbox", { name: "Search issues", exact: true }).fill(title);
    const ownerRow = member.locator(".issue-row").filter({ has: member.locator(`a[data-issue-id="${issue.id}"]`) });
    await expect(ownerRow).toContainText("Draft");
    await member.reload();
    await expect(member.getByRole("region", { name: "Table filters", exact: true }).getByRole("button", { name: /^Edit filter: State / })).toContainText("Draft");
    await member.getByRole("textbox", { name: "Search issues", exact: true }).fill(title);
    await expect(ownerRow).toContainText(title);

    await admin.goto("/issues");
    await setTableState(admin, "draft");
    await admin.getByRole("textbox", { name: "Search issues", exact: true }).fill(title);
    await expect(admin.locator(".issue-row")).toHaveCount(0);
    await expect(admin.locator(".table-empty")).toContainText(/No matching issues|No issues in this view/);
    await admin.goto(`/issues/${issue.id}`);
    await expect(admin.getByRole("alert")).toContainText("Issue not found");
    await expect(admin.locator(".detail-form")).toHaveCount(0);
    await admin.goto("/new");
    await admin.getByRole("textbox", { name: "Issue", exact: true }).fill(`See !${title}`);
    await expect(admin.getByText("No matching issues", { exact: true })).toBeVisible();
    await expect(admin.getByRole("listbox", { name: "Issue suggestions" }).getByRole("option")).toHaveCount(0);
    // Clear the unsaved composer before navigating (no unload prompt).
    await admin.getByRole("textbox", { name: "Issue", exact: true }).fill("");

    await member.goto(`/issues/${issue.id}`);
    await member.getByRole("button", { name: "Publish issue", exact: true }).click();
    await expect(member.getByRole("button", { name: "Close issue", exact: true })).toBeVisible();
    await admin.goto("/issues");
    await setTableState(admin, "open");
    await admin.getByRole("textbox", { name: "Search issues", exact: true }).fill(title);
    const sharedRow = admin.locator(".issue-row").filter({ has: admin.locator(`a[data-issue-id="${issue.id}"]`) });
    await expect(sharedRow).toContainText(title);
    await admin.goto(`/issues/${issue.id}`);
    await expect(admin.locator(".detail-form .editor-preview")).toContainText(title);
    await expect(admin.getByRole("button", { name: "Share issue", exact: true })).toBeVisible();
    await admin.goto("/new");
    await admin.getByRole("textbox", { name: "Issue", exact: true }).fill(`See !${title}`);
    const options = admin.getByRole("listbox", { name: "Issue suggestions" }).getByRole("option");
    await expect(options).toHaveCount(1);
    await expect(options).toContainText(`!${issue.number} ${title}`);
  } finally {
    await memberContext.close();
  }
});

for (const layout of [
  { name: "mobile", width: 390, height: 844, standalone: false },
  { name: "tray", width: 640, height: 800, standalone: true },
]) test(`${layout.name} draft creation controls remain usable`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: layout.width, height: layout.height });
  await page.goto(layout.standalone ? "/new" : "/issues");
  if (!layout.standalone) await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const composer = layout.standalone ? page.locator(".standalone-create") : page.getByRole("dialog", { name: "Create issue", exact: true });
  await composer.getByLabel("Project", { exact: true }).selectOption("");
  const visibility = composer.getByLabel("Visibility", { exact: true });
  await visibility.scrollIntoViewIfNeeded();
  await expect(visibility).toBeInViewport();
  await visibility.selectOption("draft");
  const privacy = composer.getByText(/Only you can see this draft/);
  await privacy.scrollIntoViewIfNeeded();
  await expect(privacy).toBeInViewport();
  await composer.getByRole("textbox", { name: "Issue", exact: true }).fill(`Responsive ${layout.name} personal draft`);
  const save = composer.getByRole("button", { name: "Save draft", exact: true });
  await expect(save).toBeEnabled();
  await expect(save).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const screenshot = testInfo.outputPath(`draft-composer-${layout.name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(`Draft composer ${layout.name}`, { path: screenshot, contentType: "image/png" });
  const created = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
  await save.click();
  const response = await created;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).issue).toMatchObject({ state: "draft", projectId: null });
  await expect(composer.getByRole("link", { name: "View issue" })).toBeVisible();
});
