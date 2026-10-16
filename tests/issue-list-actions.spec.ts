import { randomUUID } from "node:crypto";
import { openTableFilter, setTableState } from "./filter-helpers";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string, count = 31) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Pages ${randomUUID()}` } })).json();
  const ids: string[] = [];
  const numbers: number[] = [];
  for (let i = 1; i <= count; i++) {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Task ${String(i).padStart(2, "0")}`, labels: i <= 2 ? ["keep"] : [] } });
    expect(response.ok()).toBeTruthy(); const { issue } = await response.json(); ids.push(issue.id); numbers.push(issue.number);
  }
  await page.goto(`/w/default/projects/${project.slug}`);
  return { project, ids, numbers, headers };
}

for (const width of [1440, 1060, 390]) {
  test(`selection bar is compact when empty and stable while selected at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { numbers } = await seed(page, baseURL!, 12);
    const bar = page.getByRole("group", { name: "Selected issue actions", exact: true });
    const close = bar.getByRole("button", { name: "Close selected issues", exact: true });
    const tag = bar.getByRole("button", { name: "Mention", exact: true });
    const hashtags = bar.getByRole("button", { name: "Tag", exact: true });
    const send = bar.getByRole("button", { name: "Send to board", exact: true });
    const clear = bar.getByRole("button", { name: "Clear selection", exact: true });
    const table = page.getByRole("region", { name: "Scrollable issues table", exact: true });
    const tableOffset = () => table.evaluate((element) => element.getBoundingClientRect().top - element.closest(".issue-table-section")!.querySelector(".issue-table-actions")!.getBoundingClientRect().top);
    await expect(bar).toBeVisible();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, send, clear]) await expect(button).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Columns", exact: true })).toBeEnabled();
    const initialHeight = (await bar.boundingBox())!.height;
    const initialTableOffset = await tableOffset();
    expect(initialTableOffset - initialHeight).toBe(8);
    await bar.screenshot({ path: `test-results/selection-bar-empty-${width}.png` });

    await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
    await expect(bar.getByText("1 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, send, clear]) {
      await expect(button).toBeEnabled();
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBe(28);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    await expect(tag).toHaveText("Mention");
    await tag.hover();
    await expect(page.getByRole("tooltip", { name: "Mention user in selected issues", exact: true })).toBeVisible();
    await expect(hashtags).toHaveText("Tag");
    await hashtags.hover();
    await expect(page.getByRole("tooltip", { name: "Tag selected issues with labels", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    const selectedHeight = (await bar.boundingBox())!.height;
    const selectedTableOffset = await tableOffset();
    expect(initialHeight).toBeLessThanOrEqual(selectedHeight);
    expect(selectedTableOffset - selectedHeight).toBe(8);

    await page.getByRole("checkbox", { name: "Select all issues on this page", exact: true }).check();
    await expect(bar.getByText("12 selected", { exact: true })).toBeVisible();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(selectedHeight);
    expect(await tableOffset()).toBe(selectedTableOffset);
    await bar.screenshot({ path: `test-results/selection-bar-selected-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    await clear.click();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, send, clear]) await expect(button).toHaveCount(0);
    expect((await bar.boundingBox())!.height).toBe(initialHeight);
    expect(await tableOffset()).toBe(initialTableOffset);

    // Filtering updates the count; clearing lives in the permanent filter bar.
    await openTableFilter(page, "labels");
    await page.getByLabel("Filter by tag", { exact: true }).selectOption("label:keep");
    await page.keyboard.press("Escape");
    await expect(bar.getByText("2 of 12 issues", { exact: true })).toBeVisible();
    await page.getByRole("region", { name: "Table filters", exact: true }).getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
  });
}

test("pagination, cross-page selection and hidden-row reconciliation", async ({ page, baseURL }) => {
  const { numbers } = await seed(page, baseURL!);
  const rows = page.locator(".issue-row");
  const pagination = page.getByRole("navigation", { name: "Issue list pagination" });
  await expect(rows).toHaveCount(25);
  await expect(pagination).toContainText("1–25 of 31");
  await expect(pagination).toContainText("Page 1 of 2");
  await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toHaveJSProperty("indeterminate", true);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(rows).toHaveCount(6);
  await page.getByRole("checkbox", { name: `Select issue !${numbers[25]}`, exact: true }).check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).check();
  await expect(page.getByText("26 selected", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).uncheck();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await openTableFilter(page, "labels");
  await page.getByLabel("Filter by tag", { exact: true }).selectOption("label:keep");
  await page.keyboard.press("Escape");
  await expect(pagination).toContainText("Page 1 of 1");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Close selected issues" })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Sort by issue", exact: true }).click();
  await expect(pagination).toContainText("Page 1 of 2");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("Task 01");
  await expect(pagination).toContainText("Page 1 of 1");
  await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await setTableState(page, "closed");
  await expect(pagination).toContainText("0–0 of 0");
  await expect(page.getByRole("button", { name: "Close selected issues" })).toHaveCount(0);
  await setTableState(page, "open");
  await page.getByLabel("Rows per page").selectOption("10");
  await expect(rows).toHaveCount(10);
  await expect(pagination).toContainText("Page 1 of 4");
  await page.getByLabel("Rows per page").selectOption("50");
  await expect(rows).toHaveCount(31);
  await page.getByLabel("Rows per page").selectOption("100");
  await expect(rows).toHaveCount(31);
});

test("bulk close keeps failures selected, disables duplicate actions and clamps the last page", async ({ page, baseURL }) => {
  const { ids, numbers } = await seed(page, baseURL!, 26);
  await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("checkbox", { name: `Select issue !${numbers[25]}`, exact: true }).check();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/issues/${ids[0]}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await gate;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated close failure" }) });
  });
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(page.getByRole("button", { name: "Closing…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear selection" })).toBeDisabled();
  // Successful items can leave the list while another request is still pending.
  await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mention", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tag", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  release();
  await expect(page.locator('.snackbar [role="alert"]')).toContainText("1 of 2 issues closed");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Issue list pagination" })).toContainText("Page 1 of 1");
  await expect(page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true })).toBeChecked();
  await page.unroute(`**/api/issues/${ids[0]}`);
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(page.locator('.snackbar [role="status"]')).toHaveText("1 issue closed.");
  await expect(page.getByRole("button", { name: "Close selected issues" })).toHaveCount(0);
});

test("closed issues can be selected for tagging but not closing; archived issues cannot be selected", async ({ page, baseURL }) => {
  const { project, ids, headers, numbers } = await seed(page, baseURL!, 2);
  expect((await page.request.patch(`/api/issues/${ids[0]}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.reload();
  await setTableState(page, "closed");
  await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mention", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Tag", exact: true })).toBeEnabled();
  await setTableState(page, "open");
  await page.getByRole("checkbox", { name: `Select issue !${numbers[1]}`, exact: true }).check();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog", { name: "Archive project?" }).getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Select issue !${numbers[1]}`, exact: true })).toBeDisabled();
  // Archiving prunes ineligible selection rather than leaving disabled bulk actions.
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  for (const name of ["Close selected issues", "Mention", "Tag", "Send to board", "Clear selection"]) {
    await expect(page.getByRole("group", { name: "Selected issue actions", exact: true }).getByRole("button", { name, exact: true })).toHaveCount(0);
  }
});
