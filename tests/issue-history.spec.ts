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
async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `History ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Original body" } })).json();
  return { project, issue, headers };
}
for (const embedded of [false, true]) {
  test(`${embedded ? "sidebar" : "full page"} history shows saved changes and refreshes without losing drafts`, async ({ page, baseURL }) => {
    const { project, issue, headers } = await seed(page, baseURL!);
    await page.goto(embedded ? `/projects/${project.slug}` : `/issues/${issue.id}`);
    if (embedded) await page.locator(`a[data-issue-id="${issue.id}"]`).click();
    const history = page.locator(".issue-history");
    await history.locator(":scope > summary").click();
    await expect(history).toContainText("Alex Morgan created this issue");
    const form = page.locator(".detail-form");
    await form.getByRole("button", { name: "Markdown", exact: true }).click();
    const source = form.getByLabel("Markdown source");
    await source.fill("Updated body");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(history.locator(".issue-history-list > li")).toHaveCount(2);
    await history.locator(".issue-history-list > li").first().locator("summary").click();
    await expect(history.locator("pre").nth(0)).toHaveText("Original body");
    await expect(history.locator("pre").nth(1)).toHaveText("Updated body");
    await source.fill("Unsaved draft stays out of history");
    const comment = page.locator(".comments [contenteditable=true]");
    await comment.fill("A discussion update");
    await form.getByRole("button", { name: "Close issue", exact: true }).click();
    await expect(history).toContainText("State: Open → Closed");
    await expect(source).toHaveValue("Unsaved draft stays out of history");
    await expect(comment).toHaveText("A discussion update");
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(history).toContainText("Alex Morgan added a comment");
    await page.getByRole("button", { name: "Edit comment", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit comment…", exact: true }).fill("Edited discussion");
    await page.getByRole("button", { name: "Save comment", exact: true }).click();
    await expect(history).toContainText("Alex Morgan edited a comment");
    await page.getByRole("button", { name: "Delete comment", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await expect(history).toContainText("Alex Morgan deleted a comment");
    await expect(history).not.toContainText("Unsaved draft stays out of history");
    await expect(source).toHaveValue("Unsaved draft stays out of history");
    await form.getByRole("button", { name: "Discard changes", exact: true }).click();
    expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
    await page.goto(`/issues/${issue.id}`);
    await page.locator(".issue-history > summary").click();
    await expect(page.locator(".issue-history-list > li")).toHaveCount(6);
    await expect(page.locator(".issue-history")).toContainText("Alex Morgan deleted a comment");
    await expect(page.locator(".issue-read-only")).toHaveText("Updated body");
  });
}

test("history paginates, retries failures and renders historical text safely on mobile", async ({ page, baseURL }) => {
  const { issue, headers } = await seed(page, baseURL!);
  for (let i = 0; i < 51; i++) {
    expect((await page.request.patch(`/api/issues/${issue.id}`, { headers, data: { body: `Revision ${i} <script>window.historyXss=true</script>` } })).ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route(`**/api/issues/${issue.id}/history?*`, (route) => route.fulfill({ status: 503, json: { error: "History offline" } }));
  await page.goto(`/issues/${issue.id}`);
  const history = page.locator(".issue-history");
  await history.locator(":scope > summary").click();
  await expect(history.getByRole("alert")).toContainText("History offline");
  await page.unroute(`**/api/issues/${issue.id}/history?*`);
  await history.getByRole("button", { name: "Retry history", exact: true }).click();
  await expect(history.locator(".issue-history-list > li")).toHaveCount(50);
  await history.getByRole("button", { name: "Load older changes", exact: true }).click();
  await expect(history.locator(".issue-history-list > li")).toHaveCount(52);
  await expect(history.getByRole("button", { name: "Load older changes", exact: true })).toHaveCount(0);
  await history.locator(".issue-history-list > li").first().locator("summary").click();
  await expect(history.locator("pre").nth(1)).toHaveText("Revision 50 <script>window.historyXss=true</script>");
  expect(await page.evaluate(() => "historyXss" in window)).toBe(false);
  await history.locator(":scope > summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/issue-history-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
