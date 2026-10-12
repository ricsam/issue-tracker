import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Filters ${randomUUID()}` } })).json();
  for (const [body, lane, labels] of [["Todo bug", "todo", ["bug"]], ["Progress feature", "in_progress", ["feature"]], ["Done bug", "done", ["bug"]], ["Unassigned", "", []]] as const) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body, labels } })).json();
    if (lane) expect((await page.request.post(`/api/projects/${project.slug}/board/issues`, { headers, data: { lane, issueIds: [issue.id] } })).ok()).toBeTruthy();
  }
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  return { project, headers };
}

for (const width of [1440, 390]) test(`table negative repeated filters, AND/OR and persistence at ${width}px`, async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const { project, headers } = await fixture(page, baseURL!);
  const rows = page.locator("tbody .issue-link");
  const builder = page.getByRole("region", { name: "Table filters", exact: true });
  await builder.getByRole("button", { name: "Filter table", exact: true }).click();
  await builder.getByRole("button", { name: "Add filter", exact: true }).click();
  const first = builder.getByRole("group", { name: "Filter 1", exact: true });
  await first.getByLabel("Value", { exact: true }).selectOption({ label: "Todo" });
  await first.getByLabel("Operator", { exact: true }).selectOption("isNot");
  await expect(rows).toHaveText(["Progress feature", "Done bug", "Unassigned"]);
  await builder.getByRole("button", { name: "Add filter", exact: true }).click();
  const second = builder.getByRole("group", { name: "Filter 2", exact: true });
  await second.getByLabel("Field", { exact: true }).selectOption("labels");
  await second.getByLabel("Value", { exact: true }).selectOption("label:bug");
  await expect(rows).toHaveText(["Done bug"]);
  await builder.getByLabel("Combine filters").selectOption("or");
  await expect(rows).toHaveCount(4);
  await second.getByLabel("Field", { exact: true }).selectOption("lane");
  await second.getByLabel("Value", { exact: true }).selectOption({ label: "Done" });
  await expect(rows).toHaveText(["Progress feature", "Done bug", "Unassigned"]);
  await first.getByLabel("Operator", { exact: true }).selectOption("is");
  await expect(rows).toHaveText(["Todo bug", "Done bug"]);
  await page.getByRole("button", { name: "Sort by issue", exact: true }).click();
  await expect(rows).toHaveText(["Done bug", "Todo bug"]);
  await page.screenshot({ path: testInfo.outputPath(`table-filter-builder-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.reload();
  await expect(rows).toHaveText(["Done bug", "Todo bug"]);
  await builder.getByRole("button", { name: /Filter table 2 active/ }).click();
  await expect(builder.getByLabel("Combine filters")).toHaveValue("or");
  await expect(first.getByLabel("Value", { exact: true })).toHaveValue(JSON.stringify([project.id, "todo"]));
  // The column editor and full builder share the same rules and conjunction.
  await page.getByRole("button", { name: "Board lane filters (active)", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Board lane filters", exact: true });
  await expect(popover.getByLabel("Filter by board lane")).toHaveCount(2);
  await popover.getByLabel("Combine filters").selectOption("and");
  await expect(rows).toHaveCount(0);
  await popover.getByRole("button", { name: "Done", exact: true }).click();
  await builder.getByRole("button", { name: "Remove filter 2", exact: true }).click();
  await expect(rows).toHaveText(["Todo bug"]);
  // Board and other projects must not inherit table conditions.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other filters ${randomUUID()}` } })).json();
  await page.goto(`/projects/${other.slug}`);
  await expect(builder.getByRole("button", { name: "Filter table", exact: true })).toBeVisible();
  await page.goto(`/projects/${project.slug}`);
  await expect(rows).toHaveText(["Todo bug"]);
  await page.getByRole("button", { name: "Clear column filters", exact: true }).click();
  await expect(rows).toHaveCount(4);
  await page.reload();
  await expect(rows).toHaveCount(4);
});

test("moving a column rule to another field preserves independent IDs and editing", async ({ page, baseURL }) => {
  const { project } = await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Board lane filters", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Board lane filters", exact: true });
  await popover.getByLabel("Filter by board lane").selectOption({ label: "Todo" });
  await popover.getByRole("button", { name: "Done", exact: true }).click();
  const builder = page.getByRole("region", { name: "Table filters", exact: true });
  await builder.getByRole("button", { name: /Filter table/ }).click();
  const first = builder.getByRole("group", { name: "Filter 1", exact: true });
  await first.getByLabel("Field", { exact: true }).selectOption("labels");
  await first.getByLabel("Value", { exact: true }).selectOption("label:bug");
  await page.getByRole("button", { name: "Board lane filters", exact: true }).click();
  await popover.getByLabel("Filter by board lane").selectOption({ label: "Done" });
  await popover.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveText(["Done bug"]);
  await first.getByLabel("Operator", { exact: true }).selectOption("isNot");
  await expect(builder.getByRole("group", { name: "Filter 2", exact: true }).getByLabel("Operator", { exact: true })).toHaveValue("is");
  await expect(page.locator("tbody .issue-link")).toHaveCount(0);
  await builder.getByRole("button", { name: "Remove filter 1", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveText(["Done bug"]);
  await page.reload();
  await expect(page.locator("tbody .issue-link")).toHaveText(["Done bug"]);
  await page.goto("/issues");
  await page.getByRole("button", { name: "Project filters", exact: true }).click();
  await page.getByLabel("Filter by project").selectOption(project.id);
  await page.keyboard.press("Escape");
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  await page.reload();
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Project filters (active)", exact: true })).toBeVisible();
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator("tbody .issue-link")).toHaveText(["Done bug"]);
});

test("table filters remain usable with unavailable or blocked localStorage", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Board lane filters", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Board lane filters", exact: true });
  await popover.getByLabel("Filter by board lane").selectOption("none");
  await popover.getByLabel("Operator", { exact: true }).selectOption("isNot");
  await expect(page.locator("tbody .issue-link")).toHaveCount(3);
  await popover.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Clear column filters", exact: true }).click();
  await expect(page.locator("tbody .issue-link")).toHaveCount(4);
});
