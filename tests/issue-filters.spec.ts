import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { filterEditor, openTableFilter, setTableState } from "./filter-helpers";

async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Filters ${randomUUID()}` } })).json();
  for (const [body, lane, labels, closed] of [["Todo bug", "todo", ["bug"], false], ["Progress feature", "in_progress", ["feature"], false], ["Done bug", "done", ["bug", "feature"], false], ["Unassigned", "", [], false], ["Closed bug", "done", ["bug"], true]] as const) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body, labels } })).json();
    if (lane) expect((await page.request.post(`/api/projects/${project.slug}/board/issues`, { headers, data: { lane, issueIds: [issue.id] } })).ok()).toBeTruthy();
    if (closed) expect((await page.request.patch(`/api/issues/${issue.id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  }
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  return { project, headers };
}

for (const width of [1440, 390]) test(`horizontal chips, tag operators, state and persistence at ${width}px`, async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const { project } = await fixture(page, baseURL!);
  const rows = page.locator("tbody .issue-link");
  const bar = page.getByRole("region", { name: "Table filters", exact: true });
  await expect(bar.getByRole("button", { name: "Edit filter: State is Open", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort by state", exact: true })).toBeAttached();
  await expect(page.locator('tbody [data-column="state"]')).toHaveText(["Open", "Open", "Open", "Open"]);
  await expect(page.locator(".column-filter-trigger")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /Filter table/ })).toHaveCount(0);

  const editor = await openTableFilter(page, "labels");
  await editor.getByLabel("Operator", { exact: true }).selectOption("isOneOf");
  await editor.getByRole("checkbox", { name: "bug", exact: true }).check();
  await editor.getByRole("checkbox", { name: "feature", exact: true }).check();
  await expect(rows).toHaveText(["Todo bug", "Progress feature", "Done bug"]);
  await editor.getByLabel("Operator", { exact: true }).selectOption("matchesEvery");
  await expect(rows).toHaveText(["Done bug"]);
  await page.screenshot({ path: testInfo.outputPath(`filter-popover-${width}.png`), fullPage: true });
  const box = await editor.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  const tagChip = bar.getByRole("button", { name: "Edit filter: Tags matches every #bug, #feature", exact: true });
  await expect(tagChip).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`filter-chips-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.reload();
  await expect(rows).toHaveText(["Done bug"]);
  await tagChip.click();
  await expect(editor.getByRole("checkbox", { name: "feature", exact: true })).toBeChecked();
  await editor.getByRole("checkbox", { name: "feature", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(tagChip).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Edit filter: Tags matches every #bug", exact: true })).toBeFocused();
  await expect(rows).toHaveText(["Todo bug", "Done bug"]);
  await bar.getByRole("switch", { name: "Match any filter (OR)" }).click();
  await expect(rows).toHaveCount(5); // Open OR bug includes the closed bug.
  await expect(bar.getByRole("switch")).toBeChecked();
  await page.reload();
  await expect(bar.getByRole("switch")).toBeChecked();
  await expect(rows).toHaveCount(5);
  await bar.getByRole("button", { name: "Remove filter: Tags matches every #bug", exact: true }).click();
  await expect(rows).toHaveCount(4);
  await setTableState(page, "closed");
  await expect(rows).toHaveText(["Closed bug"]);
  await expect(page.locator('tbody [data-column="state"]')).toHaveText(["Closed"]);
  await bar.getByRole("button", { name: "Remove filter: State is Closed", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(bar.getByRole("button", { name: "Add filter", exact: true })).toBeFocused();
  await page.reload();
  await expect(rows).toHaveCount(5); // Explicitly cleared is not replaced with the default.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  const boardBar = page.getByRole("region", { name: "Board filters", exact: true });
  await expect(boardBar.getByRole("button", { name: "Edit filter: State is Open", exact: true })).toBeVisible();
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  await boardBar.getByRole("button", { name: "Remove filter: State is Open", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(4);
  await page.goto(`/projects/${project.slug}?state=closed`);
  await expect(rows).toHaveText(["Closed bug"]);
  await expect(bar.getByRole("button", { name: "Edit filter: State is Closed", exact: true })).toBeVisible();
});

test("repeated chip rules edit independently, support negatives and isolate project/all-issue preferences", async ({ page, baseURL }) => {
  const { project, headers } = await fixture(page, baseURL!);
  const bar = page.getByRole("region", { name: "Table filters", exact: true });
  const editor = await openTableFilter(page, "lane");
  await editor.getByLabel("Filter by board lane").selectOption({ label: "Todo" });
  await editor.getByLabel("Operator", { exact: true }).selectOption("isNot");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await bar.getByRole("button", { name: "Add filter", exact: true }).click();
  await editor.getByLabel("Field", { exact: true }).selectOption("lane");
  await editor.getByLabel("Filter by board lane").selectOption({ label: "Done" });
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveText(["Done bug"]);
  await bar.getByRole("button", { name: "Edit filter: Board lane is not Todo", exact: true }).click();
  await editor.getByLabel("Field", { exact: true }).selectOption("labels");
  await expect(editor.getByLabel("Operator", { exact: true })).toHaveValue("is");
  await editor.getByLabel("Filter by tag").selectOption("label:bug");
  await page.keyboard.press("Escape");
  await expect(bar.getByRole("button", { name: "Edit filter: Board lane is Done", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Remove filter: Board lane is Done", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveText(["Todo bug", "Done bug"]);
  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other filters ${randomUUID()}` } })).json();
  await page.goto(`/projects/${other.slug}`);
  await expect(bar.locator(".filter-chip")).toHaveCount(1);
  await page.goto("/issues");
  await openTableFilter(page, "project");
  await editor.getByLabel("Filter by project").selectOption(project.id);
  await page.keyboard.press("Escape");
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  await page.reload();
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator("tbody .issue-link")).toHaveText(["Todo bug", "Done bug"]);
  await bar.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveCount(5);
});

test("board supports title chips, any/every tags and cleared-filter persistence", async ({ page, baseURL }) => {
  const { project } = await fixture(page, baseURL!);
  await page.goto(`/projects/${project.slug}/board`);
  const bar = page.getByRole("region", { name: "Board filters", exact: true });
  const cards = page.locator(".board-card:visible");
  await expect(cards).toHaveCount(3);
  await bar.getByRole("button", { name: "Add filter", exact: true }).click();
  const editor = filterEditor(page);
  await editor.getByLabel("Value", { exact: true }).fill("bug");
  await expect(cards).toHaveCount(2);
  await editor.getByLabel("Field", { exact: true }).selectOption("labels");
  await editor.getByLabel("Operator", { exact: true }).selectOption("matchesEvery");
  await editor.getByRole("checkbox", { name: "bug", exact: true }).check();
  await editor.getByRole("checkbox", { name: "feature", exact: true }).check();
  await expect(cards).toHaveCount(1);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(cards).toHaveCount(1);
  await bar.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(cards).toHaveCount(4);
  await page.reload();
  await expect(cards).toHaveCount(4);
});

test("filter chips remain usable when browser storage is blocked", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await fixture(page, baseURL!);
  const editor = await openTableFilter(page, "lane");
  await editor.getByLabel("Filter by board lane").selectOption("none");
  await editor.getByLabel("Operator", { exact: true }).selectOption("isNot");
  await expect(page.locator("tbody .issue-link")).toHaveCount(3);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveCount(5);
});
