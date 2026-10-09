import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(response.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

test("table keyboard navigation and reversible ranges cross pages without conflating detail and selection", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Navigation ${randomUUID()}` } })).json();
  for (let index = 1; index <= 12; index++) {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Item ${String(index).padStart(2, "0")}` } });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto(`/projects/${project.slug}`);
  const table = page.getByRole("table");
  const links = table.locator("tbody .issue-link");
  const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
  await page.getByLabel("Rows per page").selectOption("10");
  await links.first().click();
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(links.first()).toBeFocused();
  await expect(sidebar).toContainText("Item 01");
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(1)).toBeFocused();
  await expect(sidebar).toContainText("Item 02");
  await expect(table.locator("tbody input:checked")).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(links.nth(2)).toBeFocused();
  await expect(table.locator("tbody input:checked")).toHaveCount(2);
  await expect(sidebar).toContainText("Item 02");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(table.locator("tbody input:checked")).toHaveCount(3);
  await page.keyboard.press("Shift+ArrowUp");
  await expect(table.locator("tbody input:checked")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await table.getByLabel("Select issue #9", { exact: true }).check();
  await table.getByLabel("Select issue #10", { exact: true }).click({ modifiers: ["Shift"] });
  await expect(table.locator("tbody input:checked")).toHaveCount(2);
  await expect(links.nth(9)).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(links.first()).toBeFocused();
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expect(sidebar).toContainText("Item 02");
  await page.keyboard.press("ArrowDown");
  await expect(links.last()).toBeFocused();
  await expect(sidebar).toContainText("Item 12");
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(links.last()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await expect(links.last()).toBeFocused();

  // Sorting invalidates the old range anchor; a first Shift-click starts anew.
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await table.getByLabel("Select issue #9", { exact: true }).check();
  await table.getByRole("button", { name: "Sort by issue", exact: true }).click();
  await table.getByRole("button", { name: "Sort by issue", exact: true }).click();
  await links.first().click({ modifiers: ["Shift"] });
  await expect(table.locator("tbody input:checked")).toHaveCount(2);
  await expect(sidebar).toContainText("Item 10");
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await table.getByLabel("Select issue #12", { exact: true }).check();
  const cell = table.locator("tbody tr").nth(2).locator("td").last();
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  // The row-wide link intentionally overlays metadata; exercise a real click there.
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.up("Shift");
  await expect(table.locator("tbody input:checked")).toHaveCount(3);
  await expect(sidebar).toContainText("Item 10");

  // Inputs and popovers retain their own keyboard behavior.
  await table.getByRole("button", { name: "Issue filters", exact: true }).click();
  const filter = table.getByLabel("Filter by issue", { exact: true });
  await filter.fill("Item 0");
  await page.keyboard.press("ArrowDown");
  await expect(filter).toBeFocused();
  await expect(sidebar).toContainText("Item 10");
  await page.keyboard.press("Escape");
  await links.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(1)).toBeFocused();
  await expect(sidebar).toContainText("Item 08");
  await sidebar.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "Issue", exact: true }).fill("Keep this keyboard draft");
  await links.nth(1).focus();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(1)).toBeFocused();
  await expect(sidebar).toContainText("Keep this keyboard draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(2)).toBeFocused();
  await expect(sidebar).toContainText("Item 07");
});

for (const width of [1440, 390]) {
  test(`issue table sorts and combines column filters without page overflow at ${width}px`, async ({ page, baseURL }) => {
    const headers = { Origin: baseURL! };
    const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Table ${randomUUID()}` } })).json();
    const { users } = await (await page.request.get("/api/users")).json();
    const alex = users.find((user: { email: string }) => user.email === "alex@example.test");
    const endpoint = `/api/projects/${project.slug}/issues`;
    const created = [];
    for (const issue of [
      { body: `# Zebra\n\nWith [@Alex Morgan](mention:${alex.id})`, labels: ["bug", "urgent"] },
      { body: "Alpha", labels: ["design"] },
      { body: "Beta", labels: [] },
    ]) {
      const response = await page.request.post(endpoint, { headers, data: issue });
      expect(response.ok()).toBeTruthy();
      created.push((await response.json()).issue);
    }
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/projects/${project.slug}`);
    const table = page.getByRole("table");
    const titles = table.locator("tbody .issue-link");
    await expect(titles).toHaveText(["Zebra", "Alpha", "Beta"]);
    await expect(table.getByRole("columnheader")).toHaveCount(7);
    await expect(table.locator(".avatar")).toHaveCount(0);
    await expect(table.locator("time").first()).toHaveAttribute("datetime", created[0].createdAt);
    await expect(table.locator(".user-tag")).toHaveText(["Alex Morgan"]);
    await table.getByRole("button", { name: "Sort by issue", exact: true }).click();
    await expect(titles).toHaveText(["Alpha", "Beta", "Zebra"]);
    await expect(table.locator("th[aria-sort=ascending]")).toContainText("Issue");
    await table.getByRole("button", { name: "Sort by issue", exact: true }).click();
    await expect(titles).toHaveText(["Zebra", "Beta", "Alpha"]);
    await table.getByRole("button", { name: "Sort by number" }).click();
    await expect(titles).toHaveText(["Zebra", "Alpha", "Beta"]);
    await table.getByRole("button", { name: "Sort by created" }).click();
    await expect(titles).toHaveText(["Zebra", "Alpha", "Beta"]);
    await table.getByRole("button", { name: "Sort by created" }).click();
    await expect(titles).toHaveText(["Beta", "Alpha", "Zebra"]);
    await table.getByRole("button", { name: "Sort by tags", exact: true }).click();
    await expect(titles).toHaveText(["Beta", "Zebra", "Alpha"]);
    await table.getByRole("button", { name: "Sort by tagged users" }).click();
    await expect(titles).toHaveText(["Alpha", "Beta", "Zebra"]);

    const labelFilters = table.getByRole("button", { name: "Tags filters", exact: true });
    await labelFilters.focus();
    await page.keyboard.press("Enter");
    const labelPopover = table.getByRole("dialog", { name: "Tags filters", exact: true });
    await expect(labelPopover).toBeVisible();
    await expect(table.getByLabel("Filter by tag", { exact: true })).toBeFocused();
    const popoverBox = (await labelPopover.boundingBox())!;
    expect(popoverBox.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/issue-filter-popover-${width}.png` });
    await table.getByLabel("Filter by tag", { exact: true }).selectOption("label:bug");
    await page.keyboard.press("Escape");
    await expect(labelPopover).toBeHidden();
    await expect(table.getByRole("button", { name: "Tags filters (active)", exact: true })).toBeFocused();
    await table.getByRole("button", { name: "Tags filters (active)", exact: true }).click();
    await labelPopover.getByRole("button", { name: "Clear tags filter" }).click();
    await expect(titles).toHaveCount(3);
    await table.getByLabel("Filter by tag", { exact: true }).selectOption("label:bug");
    await labelPopover.getByRole("button", { name: "Done", exact: true }).click();
    await expect(labelPopover).toBeHidden();
    await table.getByRole("button", { name: "Tagged users filters", exact: true }).click();
    await table.getByLabel("Filter by tagged user").selectOption(alex.id);
    await page.keyboard.press("Escape");
    await table.getByRole("button", { name: "Issue filters", exact: true }).click();
    await table.getByLabel("Filter by issue", { exact: true }).fill("zeb");
    await page.keyboard.press("Escape");
    await table.getByRole("button", { name: "Number filters", exact: true }).click();
    await table.getByLabel("Filter by number").fill("#1");
    await page.keyboard.press("Escape");
    await expect(titles).toHaveText(["Zebra"]);
    await table.getByRole("button", { name: "Created filters", exact: true }).click();
    await table.getByLabel("Created on or after").fill("2000-01-01");
    await table.getByLabel("Created on or before").fill("2000-01-02");
    await expect(titles).toHaveCount(0);
    await expect(table.getByText("No matching issues. Adjust or clear your filters.")).toBeVisible();
    await expect(table.getByLabel("Created on or before")).toBeVisible();
    await page.getByRole("button", { name: "Clear column filters" }).click();
    await expect(titles).toHaveCount(3);
    await table.getByRole("button", { name: "Tags filters", exact: true }).click();
    await table.getByLabel("Filter by tag", { exact: true }).selectOption("none");
    await expect(titles).toHaveText(["Beta"]);
    await page.getByRole("button", { name: "Clear column filters" }).click();
    await table.getByRole("button", { name: "Tagged users filters", exact: true }).click();
    await table.getByLabel("Filter by tagged user").selectOption("none");
    await expect(titles).toHaveText(["Alpha", "Beta"]);
    await page.getByRole("button", { name: "Clear column filters" }).click();
    await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("Alex Morgan");
    await expect(titles).toHaveText(["Zebra"]);
    await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const scroll = page.getByRole("region", { name: "Scrollable issues table" });
    if (width === 390) expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBeTruthy();
    await table.getByRole("button", { name: "Sort by number" }).click();
    await page.screenshot({ path: `test-results/issue-table-${width}.png`, fullPage: true });

    if (width === 1440) {
      // A new comment association updates the active table filter without a reload.
      await table.getByRole("button", { name: "Tagged users filters", exact: true }).click();
      await table.getByLabel("Filter by tagged user").selectOption("none");
      await page.keyboard.press("Escape");
      await table.getByRole("link", { name: "#2 Alpha", exact: true }).click();
      const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
      const discussion = sidebar.locator(".comments");
      await discussion.getByRole("button", { name: "Markdown", exact: true }).click();
      await discussion.getByLabel("Markdown source").fill(`Review with [@Alex Morgan](mention:${alex.id})`);
      await discussion.getByRole("button", { name: "Post comment", exact: true }).click();
      await expect(discussion.locator(".comment .mention-chip")).toContainText("Alex Morgan");
      await expect(titles).toHaveText(["Beta"]);
      await sidebar.getByRole("button", { name: "Close issue details" }).click();
      await page.getByRole("button", { name: "Clear column filters" }).click();
      await expect(titles).toHaveCount(3);
    }

    // Board remains independent, with no unassigned avatar placeholders.
    await page.request.post(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [created[0].id], lane: "todo" } });
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.reload();
    await expect(page.locator(".board-card")).toHaveCount(1);
    await expect(page.locator(".board-card .avatar")).toHaveCount(0);
    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(titles).toHaveCount(3);
  });
}
