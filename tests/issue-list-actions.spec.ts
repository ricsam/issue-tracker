import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string, count = 31) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Pages ${randomUUID()}` } })).json();
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Task ${String(i).padStart(2, "0")}`, labels: i <= 2 ? ["keep"] : [] } });
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).issue.id);
  }
  await page.goto(`/projects/${project.slug}`);
  return { project, ids, headers };
}

for (const width of [1440, 1060, 390]) {
  test(`selection bar stays compact and keeps the table in place at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    await seed(page, baseURL!, 12);
    const bar = page.getByRole("group", { name: "Selected issue actions", exact: true });
    const close = bar.getByRole("button", { name: "Close selected issues", exact: true });
    const tag = bar.getByRole("button", { name: "Tag selected issues", exact: true });
    const hashtags = bar.getByRole("button", { name: "Add tags", exact: true });
    const clear = bar.getByRole("button", { name: "Clear selection", exact: true });
    const table = page.getByRole("region", { name: "Scrollable issues table", exact: true });
    const tableOffset = () => table.evaluate((element) => element.getBoundingClientRect().top - element.closest(".issue-table-section")!.getBoundingClientRect().top);
    await expect(bar).toBeVisible();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, clear]) {
      await expect(button).toBeDisabled();
      expect((await button.boundingBox())!.height).toBe(28);
    }
    const initialHeight = (await bar.boundingBox())!.height;
    const initialTableOffset = await tableOffset();
    expect(initialTableOffset - initialHeight).toBe(8);
    await bar.screenshot({ path: `test-results/selection-bar-empty-${width}.png` });

    await page.getByRole("checkbox", { name: "Select issue #1", exact: true }).check();
    await expect(bar.getByText("1 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, clear]) await expect(button).toBeEnabled();
    expect((await bar.boundingBox())!.height).toBe(initialHeight);
    expect(await tableOffset()).toBe(initialTableOffset);

    await page.getByRole("checkbox", { name: "Select all issues on this page", exact: true }).check();
    await expect(bar.getByText("12 selected", { exact: true })).toBeVisible();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(initialHeight);
    expect(await tableOffset()).toBe(initialTableOffset);
    await bar.screenshot({ path: `test-results/selection-bar-selected-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    await clear.click();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    for (const button of [close, tag, hashtags, clear]) await expect(button).toBeDisabled();
    expect((await bar.boundingBox())!.height).toBe(initialHeight);
    expect(await tableOffset()).toBe(initialTableOffset);

    // Filtering keeps the count and clear-filter action in the same permanent bar.
    await page.getByRole("button", { name: "Tags filters", exact: true }).click();
    await page.getByLabel("Filter by tag", { exact: true }).selectOption("label:keep");
    await page.keyboard.press("Escape");
    await expect(bar.getByText("2 of 12 issues", { exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "Clear column filters", exact: true }).click();
    await expect(bar.getByText("12 of 12 issues", { exact: true })).toBeVisible();
  });
}

test("pagination, cross-page selection and hidden-row reconciliation", async ({ page, baseURL }) => {
  await seed(page, baseURL!);
  const rows = page.locator(".issue-row");
  const pagination = page.getByRole("navigation", { name: "Issue list pagination" });
  await expect(rows).toHaveCount(25);
  await expect(pagination).toContainText("1–25 of 31");
  await expect(pagination).toContainText("Page 1 of 2");
  await page.getByRole("checkbox", { name: "Select issue #1", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toHaveJSProperty("indeterminate", true);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(rows).toHaveCount(6);
  await page.getByRole("checkbox", { name: "Select issue #26", exact: true }).check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select issue #1", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).check();
  await expect(page.getByText("26 selected", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).uncheck();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Tags filters", exact: true }).click();
  await page.getByLabel("Filter by tag", { exact: true }).selectOption("label:keep");
  await page.keyboard.press("Escape");
  await expect(pagination).toContainText("Page 1 of 1");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear column filters" }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Sort by issue", exact: true }).click();
  await expect(pagination).toContainText("Page 1 of 2");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("Task 01");
  await expect(pagination).toContainText("Page 1 of 1");
  await page.getByRole("checkbox", { name: "Select issue #1", exact: true }).check();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await page.getByRole("navigation", { name: "Issue state", exact: true }).getByRole("link", { name: /Closed/ }).click();
  await expect(pagination).toContainText("0–0 of 0");
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
  await page.getByRole("navigation", { name: "Issue state", exact: true }).getByRole("link", { name: /Open/ }).click();
  await page.getByLabel("Rows per page").selectOption("10");
  await expect(rows).toHaveCount(10);
  await expect(pagination).toContainText("Page 1 of 4");
  await page.getByLabel("Rows per page").selectOption("50");
  await expect(rows).toHaveCount(31);
  await page.getByLabel("Rows per page").selectOption("100");
  await expect(rows).toHaveCount(31);
});

test("bulk close keeps failures selected, disables duplicate actions and clamps the last page", async ({ page, baseURL }) => {
  const { ids } = await seed(page, baseURL!, 26);
  await page.getByRole("checkbox", { name: "Select issue #1", exact: true }).check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select issue #26", exact: true }).check();
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
  await expect(page.getByRole("button", { name: "Tag selected issues" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add tags" })).toBeDisabled();
  release();
  await expect(page.locator(".issue-bulk-outcome")).toContainText("1 of 2 issues closed");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Issue list pagination" })).toContainText("Page 1 of 1");
  await expect(page.getByRole("checkbox", { name: "Select issue #1", exact: true })).toBeChecked();
  await page.unroute(`**/api/issues/${ids[0]}`);
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(page.locator(".issue-bulk-outcome")).toHaveText("1 issue closed.");
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
});

test("closed issues can be selected for tagging but not closing; archived issues cannot be selected", async ({ page, baseURL }) => {
  const { project, ids, headers } = await seed(page, baseURL!, 2);
  expect((await page.request.patch(`/api/issues/${ids[0]}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.goto(`/projects/${project.slug}?state=closed`);
  await page.getByRole("checkbox", { name: "Select issue #1", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tag selected issues" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add tags" })).toBeEnabled();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("checkbox", { name: "Select issue #2", exact: true }).check();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog", { name: "Archive project?" }).getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select issue #2", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close selected issues" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tag selected issues" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add tags" })).toBeDisabled();
});
