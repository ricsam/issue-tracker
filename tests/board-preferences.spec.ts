import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Preferences ${randomUUID()}` } })).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  for (const [lane, tag] of [["todo", "bug"], ["in_progress", "feature"], ["done", "bug"]]) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `${lane} preference card`, labels: [tag] } })).json();
    expect((await page.request.post(`${endpoint}/issues`, { headers, data: { lane, issueIds: [issue.id] } })).ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  return { project, endpoint, headers };
}

async function addFilter(page: Page, field: string, value: string, operator = "is") {
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  const row = page.getByRole("group", { name: /^Filter \d+$/ }).last();
  await row.getByLabel("Field", { exact: true }).selectOption(field);
  await row.getByLabel("Operator", { exact: true }).selectOption(operator);
  await row.getByLabel("Value", { exact: true }).selectOption(value);
}

test("personal collapse persists without writes, prunes selection, skips keyboard targets and permits drops", async ({ page, baseURL }) => {
  const { endpoint } = await fixture(page, baseURL!);
  const original = (await (await page.request.get(endpoint)).json()).board;
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.getByRole("button", { name: "Select visible issues", exact: true }).click();
  await page.getByRole("button", { name: "Collapse In progress lane", exact: true }).click();
  await expect(page.locator(".issue-selection-count")).toHaveText("2 selected");
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  const first = page.locator(".board-card:visible a.issue-link").first();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".board-card:visible a.issue-link").last()).toBeFocused();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand In progress lane", exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(writes).toEqual([]);
  expect((await (await page.request.get(endpoint)).json()).board).toEqual(original);
  const collapsed = page.locator(".board-column.is-collapsed");
  // Drop near the heading so the larger filter panel cannot push the target offscreen.
  await page.locator(".board-card:visible .board-card-handle").first().dragTo(collapsed, { targetPosition: { x: 60, y: 90 } });
  await expect(collapsed).toContainText("2 matching issues");
  await page.getByRole("button", { name: "Expand In progress lane", exact: true }).click();
  await expect(collapsed).toHaveCount(0);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
});

test("filter picks, search and collapsed active badge survive reload and stay board-scoped", async ({ page, baseURL }) => {
  const { project, headers } = await fixture(page, baseURL!);
  await addFilter(page, "labels", "label:bug");
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("preference");
  await page.getByRole("button", { name: /Filter board 2 active/ }).click();
  await expect(page.getByRole("button", { name: /Filter board 2 active · search/ })).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Filter board 2 active · search/ })).toHaveAttribute("aria-expanded", "false");
  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other ${randomUUID()}` } })).json();
  await page.goto(`/projects/${other.slug}/board`);
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Filter board", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Filter board", exact: true })).toHaveAttribute("aria-expanded", "false");
});

test("mobile filters support negative AND and OR conditions with stacked collapsed lanes", async ({ page, baseURL }, testInfo) => {
  await fixture(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Collapse Todo lane", exact: true }).click();
  const columns = page.locator(".board-column");
  await columns.first().scrollIntoViewIfNeeded();
  const first = (await columns.first().boundingBox())!;
  const second = (await columns.nth(1).boundingBox())!;
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(second.x).toBeCloseTo(first.x, 0);
  await addFilter(page, "labels", "label:bug", "isNot");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await addFilter(page, "lane", "done");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
  await page.getByLabel("Combine filters", { exact: true }).selectOption("or");
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  const box = (await page.getByRole("group", { name: "Filter 2", exact: true }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile-board-filter.png") });
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByLabel("Combine filters", { exact: true })).toHaveValue("or");
  await page.getByRole("button", { name: /Filter board 2 active/ }).click();
  await expect(page.getByRole("button", { name: /Filter board 2 active/ })).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("desktop negative filters combine with AND or OR and ignore drafts", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await addFilter(page, "labels", "label:bug", "isNot");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await addFilter(page, "lane", "done");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
  await page.getByLabel("Combine filters", { exact: true }).selectOption("or");
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Filter board 2 active/ })).toBeVisible();
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByRole("group", { name: /^Filter \d+$/ })).toHaveCount(3);
  await expect(page.getByRole("group", { name: "Filter 1", exact: true }).getByLabel("Operator", { exact: true })).toHaveValue("isNot");
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("done");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Filter board", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByRole("group", { name: /^Filter \d+$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: /^Filter \d+$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeDisabled();
});

test("legacy board preferences migrate on reload and persist when edited", async ({ page, baseURL }) => {
  const { project } = await fixture(page, baseURL!);
  // Trigger a preference write to discover the exact current user/board scope.
  await page.getByRole("button", { name: "Collapse Todo lane", exact: true }).click();
  await page.evaluate((boardId) => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("threadline:board-preferences:v1:") && key.endsWith(`:${encodeURIComponent(boardId)}`));
    if (!key) throw new Error("Board preference scope missing");
    localStorage.setItem(key, JSON.stringify({ filters: { state: "all", lane: "", tags: ["bug"], users: [], creator: "" }, search: "", filtersExpanded: true, collapsedLanes: [] }));
  }, project.id);
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByRole("group", { name: "Filter 1", exact: true }).getByLabel("Value", { exact: true })).toHaveValue("label:bug");
  await page.getByRole("group", { name: "Filter 1", exact: true }).getByLabel("Operator", { exact: true }).selectOption("isNot");
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
});

test("closing details restores focus to expand when its card's lane is collapsed", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await page.locator(".board-card a.issue-link").first().click();
  await expect(page.getByRole("complementary", { name: "Issue details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse Todo lane", exact: true }).click();
  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand Todo lane", exact: true })).toBeFocused();
});

test("blocked board storage does not prevent personal controls", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Collapse Todo lane", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await addFilter(page, "labels", "label:feature");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
});

test("archived boards allow personal collapse and filters but not shared edits", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage lanes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Collapse Todo lane", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand Todo lane", exact: true })).toBeEnabled();
  await addFilter(page, "state", "closed");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
});
