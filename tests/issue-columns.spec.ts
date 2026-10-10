import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let userId: string;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(response.ok()).toBeTruthy();
  userId = (await (await request.get("/api/auth/status")).json()).user.id;
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

for (const width of [320, 390, 1440]) {
  test(`column configuration saves order and visibility without changing filters or selection at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 800 });
    const headers = { Origin: baseURL! };
    const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Columns ${randomUUID()}` } })).json();
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Column test #bug" } })).json();
    await page.goto(`/projects/${project.slug}`);
    const table = page.getByRole("table");
    const headings = table.locator(".column-sort");
    const initial = ["Number", "Issue", "Board lane", "Tags", "Tagged users", "Creator", "Created"];
    await expect(headings).toHaveText(initial);
    await table.getByLabel(`Select issue !${issue.number}`, { exact: true }).check();
    await table.getByRole("button", { name: "Tags filters", exact: true }).click();
    await table.getByLabel("Filter by tag", { exact: true }).selectOption("label:bug");
    await page.keyboard.press("Escape");
    const configure = page.getByRole("button", { name: "Columns", exact: true });
    await configure.click();
    const dialog = page.getByRole("dialog", { name: "Table columns", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Show Issue column", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Show Project column", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Show Tags column", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Move Created column up", exact: true }).click();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Move Created column up", exact: true })).toBeFocused();
    await expect(dialog.getByRole("listitem").nth(4)).toContainText("Created");
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    const saveBounds = (await dialog.getByRole("button", { name: "Save columns", exact: true }).boundingBox())!;
    expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(box.y + box.height);
    await page.screenshot({ path: `test-results/issue-columns-${width}.png` });
    await dialog.getByRole("button", { name: "Save columns", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(configure).toBeFocused();
    const saved = ["Number", "Issue", "Board lane", "Created", "Tagged users", "Creator"];
    await expect(headings).toHaveText(saved);
    expect(await table.locator("tbody tr").first().locator("td[data-column]").evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-column")))).toEqual(["number", "title", "lane", "created", "tagged", "creator"]);
    await expect(table.locator("tbody input:checked")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Clear column filters", exact: true })).toBeVisible();
    await configure.click();
    await dialog.getByLabel("Show Number column", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(headings).toHaveText(saved);
    await configure.click();
    await dialog.getByLabel("Show Number column", { exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(configure).toBeFocused();
    await expect(headings).toHaveText(saved);
    await page.reload();
    await expect(headings).toHaveText(saved);
    // Preferences apply to other project lists, not All issues.
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/board$`));
    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(headings).toHaveText(saved);
    await configure.click();
    for (const label of ["Number", "Board lane", "Tagged users", "Creator", "Created"]) await dialog.getByLabel(`Show ${label} column`, { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save columns", exact: true }).click();
    await expect(headings).toHaveText(["Issue"]);
    await expect(table).toHaveCSS("min-width", "322px");
    expect(await table.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(Math.max(322, width - 40));
    await table.locator(".issue-link").click();
    if (width < 1024) {
      await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
      await page.goBack();
    } else await page.getByRole("button", { name: "Close issue details", exact: true }).click();
    await expect(headings).toHaveText(["Issue"]);
    await page.goto("/issues");
    await expect(headings).toHaveText(["Number", "Issue", "Project", ...initial.slice(2)]);
    await configure.click();
    await dialog.getByLabel("Show Project column", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save columns", exact: true }).click();
    await page.reload();
    await expect(headings).toHaveText(initial);
    await page.goto(`/projects/${project.slug}`);
    await expect(headings).toHaveText(["Issue"]);
    await configure.click();
    await dialog.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await dialog.getByRole("button", { name: "Save columns", exact: true }).click();
    await expect(headings).toHaveText(initial);
    await page.reload();
    await expect(headings).toHaveText(initial);
  });
}

test("invalid or inaccessible storage does not break the table or configuration", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Storage ${randomUUID()}` } })).json();
  await page.goto(`/projects/${project.slug}`);
  await page.evaluate((id) => localStorage.setItem(`threadline:issue-columns:v1:${encodeURIComponent(id)}:project`, "not-json"), userId);
  await page.reload();
  await expect(page.getByRole("table").locator(".column-sort")).toHaveCount(7);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage unavailable"); };
    Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); };
  });
  await page.reload();
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Table columns", exact: true });
  await dialog.getByLabel("Show Number column", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Save columns", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("table").locator(".column-sort")).toHaveCount(6);
  await expect(page.getByText("Columns updated for this visit, but browser storage is unavailable.")).toBeVisible();
});
