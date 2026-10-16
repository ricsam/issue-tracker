import { randomUUID } from "node:crypto";
import { laneAction } from "./board-lane-helpers";
import { test, expect, type Page } from "@playwright/test";
import { addBoardFilter as addFilter, boardFilters, clearBoardFilters, filterEditor } from "./board-filter-helpers";

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
  await page.goto(`/w/default/projects/${project.slug}/board`);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  return { project, endpoint, headers };
}

test("personal collapse persists without writes, prunes selection, skips keyboard targets and permits drops", async ({ page, baseURL }) => {
  const { endpoint } = await fixture(page, baseURL!);
  const original = (await (await page.request.get(endpoint)).json()).board;
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.getByRole("button", { name: "Select visible issues", exact: true }).click();
  await laneAction(page, "In progress", "Collapse");
  await expect(page.locator(".issue-selection-count")).toHaveText("2 selected");
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  const first = page.locator(".board-card:visible a.issue-link").first();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".board-card:visible a.issue-link").last()).toBeFocused();
  await page.reload();
  await expect(page.locator('[data-lane="in_progress"]')).toHaveClass(/is-collapsed/);
  expect(writes).toEqual([]);
  expect((await (await page.request.get(endpoint)).json()).board).toEqual(original);
  const collapsed = page.locator(".board-column.is-collapsed");
  // Drop near the heading so the larger filter panel cannot push the target offscreen.
  await page.locator(".board-card:visible .board-card-handle").first().dragTo(collapsed, { targetPosition: { x: 16, y: 90 } });
  await expect(collapsed).toContainText("2 matching issues");
  await laneAction(page, "In progress", "Expand");
  await expect(collapsed).toHaveCount(0);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
});

test("filters stay visible and remember independent conditions per board", async ({ page, baseURL }) => {
  const { project, headers } = await fixture(page, baseURL!);
  const builder = boardFilters(page).getByRole("button", { name: "Add filter", exact: true });
  await expect(boardFilters(page)).toBeVisible();
  await expect(builder).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filter board/ })).toHaveCount(0);
  await expect(boardFilters(page).getByRole("button", { name: "Edit filter: State is Open", exact: true })).toBeVisible();
  await addFilter(page, "lane", "todo");
  await page.reload();
  await expect(builder).toBeVisible();
  await expect(page.locator(".board-card:visible")).toHaveCount(1);

  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other filters ${randomUUID()}` } })).json();
  await page.goto(`/w/default/projects/${other.slug}/board`);
  await expect(builder).toBeVisible();
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(1);
  await addFilter(page, "lane", "done");
  await page.goto(`/w/default/projects/${project.slug}/board`);
  await expect(builder).toBeVisible();
  await expect(boardFilters(page).getByRole("button", { name: "Edit filter: Lane is Todo", exact: true })).toBeVisible();
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await clearBoardFilters(page);
  await page.reload();
  await expect(builder).toBeVisible();
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(0);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await page.goto(`/w/default/projects/${other.slug}/board`);
  await expect(boardFilters(page).getByRole("button", { name: "Edit filter: Lane is Done", exact: true })).toBeVisible();
});

for (const width of [1440, 390]) test(`state and lane filter values are readable and usable at ${width}px`, async ({ page, baseURL }, testInfo) => {
  const { endpoint, headers } = await fixture(page, baseURL!);
  const { board } = await (await page.request.get(endpoint)).json();
  expect((await page.request.patch(`/api/issues/${board.cards[0].issueId}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.reload();
  await page.setViewportSize({ width, height: 900 });
  await clearBoardFilters(page);
  await addFilter(page, "state", "closed");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await addFilter(page, "lane", "todo");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  for (const [summary, expected] of [["State is Closed", "closed"], ["Lane is Todo", "todo"]]) {
    await boardFilters(page).getByRole("button", { name: `Edit filter: ${summary}`, exact: true }).click();
    const value = filterEditor(page).getByLabel("Value", { exact: true });
    await expect(value).toHaveValue(expected);
    const box = (await value.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(50);
    expect(box.width).toBeGreaterThan(100);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  }
  await boardFilters(page).screenshot({ path: testInfo.outputPath(`state-lane-${width}.png`) });
  await boardFilters(page).getByRole("button", { name: "Edit filter: Lane is Todo", exact: true }).click();
  await filterEditor(page).getByLabel("Value", { exact: true }).selectOption("done");
  await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
});

test("filter chips and search survive reload and stay board-scoped", async ({ page, baseURL }) => {
  const { project, headers } = await fixture(page, baseURL!);
  await addFilter(page, "labels", "label:bug");
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("preference");
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(boardFilters(page).getByRole("button", { name: "Edit filter: Tags is #bug", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("preference");
  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other ${randomUUID()}` } })).json();
  await page.goto(`/w/default/projects/${other.slug}/board`);
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("");
  await expect(boardFilters(page)).toBeVisible();
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(1);
  await page.goto(`/w/default/projects/${project.slug}/board`);
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await clearBoardFilters(page);
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("");
  await expect(boardFilters(page)).toBeVisible();
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(0);
});

test("mobile filters support negative AND and OR conditions with compact collapsed lanes", async ({ page, baseURL }, testInfo) => {
  await fixture(page, baseURL!);
  await clearBoardFilters(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await laneAction(page, "Todo", "Collapse");
  const columns = page.locator(".board-column");
  await columns.first().scrollIntoViewIfNeeded();
  const first = (await columns.first().boundingBox())!;
  const second = (await columns.nth(1).boundingBox())!;
  expect(first.width).toBeLessThanOrEqual(32);
  expect(second.x).toBeGreaterThan(first.x + first.width);
  expect(second.y).toBeCloseTo(first.y, 0);
  await addFilter(page, "labels", "label:bug", "isNot");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await addFilter(page, "lane", "done");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
  await boardFilters(page).getByRole("switch", { name: "Match any filter (OR)", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  const box = (await boardFilters(page).getByRole("button", { name: "Edit filter: Lane is Done", exact: true }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile-board-filter.png") });
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(boardFilters(page).getByRole("switch", { name: "Match any filter (OR)", exact: true })).toBeChecked();
  await expect(boardFilters(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("desktop negative filters combine with AND or OR and ignore drafts", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await clearBoardFilters(page);
  await addFilter(page, "labels", "label:bug", "isNot");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await addFilter(page, "lane", "done");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
  await boardFilters(page).getByRole("switch", { name: "Match any filter (OR)", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(filterEditor(page).getByLabel("Field", { exact: true })).toHaveValue("title");
  await expect(filterEditor(page).getByLabel("Value", { exact: true })).toHaveValue("");
  await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(3);
  await boardFilters(page).getByRole("button", { name: "Edit filter: Tags is not #bug", exact: true }).click();
  await expect(filterEditor(page).getByLabel("Operator", { exact: true })).toHaveValue("isNot");
  await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("done");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await clearBoardFilters(page);
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toHaveValue("done");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await boardFilters(page).getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(filterEditor(page)).toBeVisible();
  await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(boardFilters(page).getByRole("button", { name: "Clear filters", exact: true })).toBeEnabled();
  await clearBoardFilters(page);
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(0);
  await page.reload();
  await expect(boardFilters(page).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(0);
  await expect(boardFilters(page).getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
});

test("legacy board preferences migrate on reload and persist when edited", async ({ page, baseURL }) => {
  const { project } = await fixture(page, baseURL!);
  // Trigger a preference write to discover the exact current user/board scope.
  await laneAction(page, "Todo", "Collapse");
  await page.evaluate((boardId) => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("threadline:board-preferences:v1:") && key.endsWith(`:${encodeURIComponent(boardId)}`));
    if (!key) throw new Error("Board preference scope missing");
    localStorage.setItem(key, JSON.stringify({ filters: { state: "all", lane: "", tags: ["bug"], users: [], creator: "" }, search: "", filtersExpanded: true, collapsedLanes: [] }));
  }, project.id);
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await boardFilters(page).getByRole("button", { name: "Edit filter: Tags is #bug", exact: true }).click();
  await expect(filterEditor(page).getByLabel("Value", { exact: true })).toHaveValue("label:bug");
  await filterEditor(page).getByLabel("Operator", { exact: true }).selectOption("isNot");
  await filterEditor(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
});

test("closing details restores focus to lane actions when its card's lane is collapsed", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await page.locator(".board-card a.issue-link").first().click();
  await expect(page.getByRole("complementary", { name: "Issue details", exact: true })).toBeVisible();
  await laneAction(page, "Todo", "Collapse");
  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Todo lane actions", exact: true })).toBeFocused();
});

test("blocked board storage does not prevent personal controls", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await fixture(page, baseURL!);
  await laneAction(page, "Todo", "Collapse");
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await addFilter(page, "labels", "label:feature");
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
});

test("archived boards allow personal collapse and filters but not shared edits", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive project", exact: true }).click();
  await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Manage lanes", exact: true });
  await expect(settings.getByLabel("Create a new lane", { exact: true })).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Save board", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await laneAction(page, "Todo", "Collapse");
  await expect(page.getByRole("button", { name: "Todo lane actions", exact: true })).toBeEnabled();
  await clearBoardFilters(page);
  await addFilter(page, "state", "closed");
  await expect(page.locator(".board-card:visible")).toHaveCount(0);
});
