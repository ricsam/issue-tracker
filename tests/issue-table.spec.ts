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
    await expect(table.getByRole("columnheader")).toHaveCount(6);
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
    await table.getByRole("button", { name: "Sort by labels", exact: true }).click();
    await expect(titles).toHaveText(["Beta", "Zebra", "Alpha"]);
    await table.getByRole("button", { name: "Sort by tagged users" }).click();
    await expect(titles).toHaveText(["Alpha", "Beta", "Zebra"]);

    const labelFilters = table.getByRole("button", { name: "Labels filters", exact: true });
    await labelFilters.focus();
    await page.keyboard.press("Enter");
    const labelPopover = table.getByRole("dialog", { name: "Labels filters", exact: true });
    await expect(labelPopover).toBeVisible();
    await expect(table.getByLabel("Filter by label", { exact: true })).toBeFocused();
    const popoverBox = (await labelPopover.boundingBox())!;
    expect(popoverBox.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/issue-filter-popover-${width}.png` });
    await table.getByLabel("Filter by label", { exact: true }).selectOption("label:bug");
    await page.keyboard.press("Escape");
    await expect(labelPopover).toBeHidden();
    await expect(table.getByRole("button", { name: "Labels filters (active)", exact: true })).toBeFocused();
    await table.getByRole("button", { name: "Labels filters (active)", exact: true }).click();
    await labelPopover.getByRole("button", { name: "Clear labels filter" }).click();
    await expect(titles).toHaveCount(3);
    await table.getByLabel("Filter by label", { exact: true }).selectOption("label:bug");
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
    await table.getByRole("button", { name: "Labels filters", exact: true }).click();
    await table.getByLabel("Filter by label", { exact: true }).selectOption("none");
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
      await expect(sidebar.getByRole("list", { name: "Tagged users" })).toContainText("Alex Morgan");
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
