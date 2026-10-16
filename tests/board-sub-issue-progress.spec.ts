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
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Progress ${randomUUID()}` } })).json();
  const create = async (body: string, extra = {}) => {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body, ...extra } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).issue;
  };
  const parent = await create("Epic: a larger piece of work", { lane: "todo" });
  const first = await create("First sub-issue", { parentId: parent.id, lane: "todo" });
  const second = await create("Second sub-issue", { parentId: parent.id });
  const leaf = await create("Ordinary issue", { lane: "todo" });
  return { project, parent, first, second, leaf, headers, create };
}
const card = (page: Page, id: string) => page.locator(".board-card").filter({ has: page.locator(`a[data-issue-id="${id}"]`) });

test("card progress counts closed direct children, refreshes after close/reopen and bulk close, and survives filtering/reload", async ({ page, baseURL }, testInfo) => {
  const { project, parent, first, second, leaf, headers } = await seed(page, baseURL!);
  let individualRelationshipReads = 0;
  page.on("request", (request) => { if (/\/api\/issues\/\d+\/relationships$/.test(request.url())) individualRelationshipReads++; });
  await page.goto(`/projects/${project.slug}/board`);
  const parentCard = card(page, parent.id);
  const progress = parentCard.getByRole("progressbar", { name: `Sub-issues for issue !${parent.number}` });
  await expect(progress).toHaveAttribute("aria-valuetext", "0 of 2 sub-issues closed (0%)");
  await parentCard.screenshot({ path: testInfo.outputPath("board-progress-empty.png") });
  await expect(card(page, leaf.id).getByRole("progressbar")).toHaveCount(0);
  expect(individualRelationshipReads).toBe(0); // One aggregate request, not one per card.
  // Completion is based on lifecycle, never the lane.
  expect((await page.request.put(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [second.id], lane: "done" } })).ok()).toBeTruthy();
  await page.reload();
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await card(page, first.id).getByRole("link", { name: first.title, exact: true }).click();
  const detail = page.locator(".detail-container");
  await detail.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await detail.locator(".detail-form").getByLabel("Markdown source").fill("Keep my unsaved child edit");
  await detail.getByRole("button", { name: "Close as completed", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuetext", "1 of 2 sub-issues closed (50%)");
  await parentCard.screenshot({ path: testInfo.outputPath("board-progress-half.png") });
  await expect(detail.locator(".detail-form").getByLabel("Markdown source")).toHaveValue("Keep my unsaved child edit");
  await detail.getByRole("button", { name: "Reopen issue", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await detail.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  await card(page, first.id).getByRole("checkbox").check();
  await card(page, second.id).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Close selected issues", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuetext", "2 of 2 sub-issues closed (100%)");
  await expect(progress).toContainText("2 / 2");
  await expect(progress).toContainText("100%");
  await parentCard.screenshot({ path: testInfo.outputPath("board-progress-complete.png") });
  await page.getByRole("textbox", { name: "Search issues" }).fill("Epic:");
  await expect(progress).toHaveAttribute("aria-valuemax", "2");
  await page.reload();
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  // The progress itself is still part of the card's navigation surface.
  await progress.click();
  await expect(detail.getByRole("link", { name: `ISSUE !${parent.number}`, exact: true })).toBeVisible();
});

test("linking, creating and unlinking from the parent panel refreshes its card without losing edits", async ({ page, baseURL }) => {
  const { project, parent, first, second, leaf } = await seed(page, baseURL!);
  await page.goto(`/projects/${project.slug}/board`);
  const progress = card(page, parent.id).getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuemax", "2");
  await card(page, parent.id).getByRole("link", { name: parent.title, exact: true }).click();
  const detail = page.locator(".detail-container");
  const source = detail.locator(".detail-form").getByLabel("Markdown source");
  await detail.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await source.fill("Keep parent edits");
  const section = detail.getByRole("region", { name: "Issue relationships" });
  await section.getByRole("button", { name: `Remove sub-issue !${first.number}`, exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuemax", "1");
  await section.getByRole("button", { name: "Add existing issue", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add existing sub-issue" });
  await picker.getByRole("searchbox").fill(`!${leaf.number}`);
  await picker.getByRole("button", { name: `Add !${leaf.number} ${leaf.title}`, exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuemax", "2");
  await section.getByRole("button", { name: "Create sub-issue", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Create sub-issue", exact: true });
  await composer.getByRole("button", { name: "Markdown", exact: true }).click();
  await composer.getByLabel("Markdown source").fill("Created from parent");
  await composer.getByRole("button", { name: "Create sub-issue", exact: true }).click();
  await composer.getByRole("button", { name: "Done", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuemax", "3");
  await expect(source).toHaveValue("Keep parent edits");
  for (const child of [second, leaf]) {
    await section.getByRole("button", { name: `Remove sub-issue !${child.number}`, exact: true }).click();
  }
  await section.getByRole("button", { name: /Remove sub-issue/ }).click();
  await expect(progress).toHaveCount(0);
  await expect(source).toHaveValue("Keep parent edits");
});

test("focus refresh picks up external changes; failed refresh hides stale counts and can retry", async ({ page, baseURL }) => {
  const { project, parent, second, headers } = await seed(page, baseURL!);
  const endpoint = `/api/projects/${project.slug}/board/sub-issue-progress`;
  await page.goto(`/projects/${project.slug}/board`);
  const progress = card(page, parent.id).getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  expect((await page.request.patch(`/api/issues/${second.id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(progress).toHaveAttribute("aria-valuenow", "1");
  await page.route(`**${endpoint}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not refresh sub-issue progress");
  await expect(progress).toHaveCount(0);
  await page.unroute(`**${endpoint}`);
  await page.getByRole("button", { name: "Retry sub-issue progress" }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByRole("button", { name: "Retry sub-issue progress" })).toHaveCount(0);
});

test("segmented progress fits mobile cards and scales to large counts without one element per child", async ({ page, baseURL }) => {
  const { project, parent } = await seed(page, baseURL!);
  await page.route(`**/api/projects/${project.slug}/board/sub-issue-progress`, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ progress: { [parent.id]: { total: 1000, closed: 999 } } }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.slug}/board`);
  const progress = card(page, parent.id).getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuetext", "999 of 1000 sub-issues closed (99%)");
  await expect(progress.locator(".board-sub-issue-track")).toHaveCSS("--sub-issue-segments", "20");
  expect(await progress.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  expect(await progress.locator("*").count()).toBe(3);
});
