import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { laneAction } from "./board-lane-helpers";

async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Lane menu ${randomUUID()}` } })).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  for (const lane of ["todo", "in_progress", "done"]) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `${lane} menu card` } })).json();
    expect((await page.request.post(`${endpoint}/issues`, { headers, data: { lane, issueIds: [issue.id] } })).ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card:visible")).toHaveCount(3);
  const getBoard = async () => (await (await page.request.get(endpoint)).json()).board;
  return { project, endpoint, headers, getBoard };
}
const headings = (page: Page) => page.locator(".board-column h2 .lane-name");
const menu = (page: Page, lane: string) => page.getByRole("menu", { name: `${lane} lane actions`, exact: true });

test("lane menu supports keyboard navigation, 32px rotated collapse and viewport-safe positioning", async ({ page, baseURL }, testInfo) => {
  await fixture(page, baseURL!);
  const trigger = page.getByRole("button", { name: "Todo lane actions", exact: true });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page, "Todo").getByRole("menuitem", { name: "Collapse", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu(page, "Todo").getByRole("menuitem", { name: "Move to right", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await laneAction(page, "Todo", "Collapse");
  const rail = page.locator('[data-lane="todo"]');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await rail.scrollIntoViewIfNeeded();
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(32);
    await expect(rail.locator("h2")).toHaveCSS("writing-mode", "vertical-rl");
    await trigger.click();
    await expect(menu(page, "Todo").getByRole("menuitem", { name: "Expand", exact: true })).toBeVisible();
    const box = (await menu(page, "Todo").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath(`collapsed-lane-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  await laneAction(page, "Todo", "Expand");
  await expect(rail).not.toHaveClass(/is-collapsed/);
});

test("hide is personal, persistent, prunes selection and keyboard targets, and can restore every lane", async ({ page, baseURL, browser }) => {
  const { project, getBoard, headers } = await fixture(page, baseURL!);
  const before = await getBoard();
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.getByRole("button", { name: "Select visible issues", exact: true }).click();
  await laneAction(page, "In progress", "Hide");
  await expect(headings(page)).toHaveText(["Todo", "Done"]);
  await expect(page.locator(".issue-selection-count")).toHaveText("2 selected");
  await expect(page.getByRole("button", { name: "Hidden lanes (1)", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.locator(".board-card a.issue-link").first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".board-card a.issue-link").last()).toBeFocused();
  await page.reload();
  await expect(headings(page)).toHaveText(["Todo", "Done"]);
  expect(writes).toEqual([]);
  expect(await getBoard()).toEqual(before);
  // A fresh browser view (even for the same account) still sees the shared board.
  const other = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] } });
  try {
    const tab = await other.newPage();
    await tab.goto(`${baseURL}/projects/${project.slug}/board`);
    await expect(headings(tab)).toHaveText(["Todo", "In progress", "Done"]);
  } finally { await other.close(); }
  const { project: second } = await (await page.request.post("/api/projects", { headers, data: { name: `Other board ${randomUUID()}` } })).json();
  await page.goto(`/projects/${second.slug}/board`);
  await expect(headings(page)).toHaveText(["Todo", "In progress", "Done"]);
  await page.goto(`/projects/${project.slug}/board`);
  await laneAction(page, "Todo", "Collapse");
  await laneAction(page, "Todo", "Hide");
  await laneAction(page, "Done", "Hide");
  await expect(page.locator(".board-column")).toHaveCount(0);
  await page.getByRole("button", { name: "Hidden lanes (3)", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show Todo", exact: true }).click();
  await expect(page.locator('[data-lane="todo"]')).toHaveClass(/is-collapsed/);
  await expect(page.getByRole("button", { name: "Todo lane actions", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Hidden lanes (2)", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show all lanes", exact: true }).click();
  await expect(headings(page)).toHaveText(["Todo", "In progress", "Done"]);
  await expect(page.getByRole("button", { name: /^Hidden lanes/ })).toHaveCount(0);
  expect(await getBoard()).toEqual(before);
});

test("rename, move and remove update the shared board without losing cards; errors preserve state", async ({ page, baseURL }) => {
  const { endpoint, headers, getBoard } = await fixture(page, baseURL!);
  const original = await getBoard();
  await laneAction(page, "Todo", "Rename");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Lane name", { exact: true }).fill("Done");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Lane name", { exact: true }).fill("Ready for work");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready for work lane actions", exact: true })).toBeFocused();
  await page.reload();
  await expect(headings(page)).toHaveText(["Ready for work", "In progress", "Done"]);
  await page.locator('[data-lane="todo"] a.issue-link').click();
  await expect(page.getByRole("button", { name: "Change board lane", exact: true })).toContainText("Ready for work");
  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  await laneAction(page, "Ready for work", "Move to right");
  await expect(headings(page)).toHaveText(["In progress", "Ready for work", "Done"]);
  await laneAction(page, "Ready for work", "Move to left");
  await expect(headings(page)).toHaveText(["Ready for work", "In progress", "Done"]);
  await laneAction(page, "In progress", "Hide");
  await laneAction(page, "Ready for work", "Move to right");
  await expect(headings(page)).toHaveText(["Done", "Ready for work"]);
  await expect.poll(async () => (await getBoard()).lanes).toEqual(["in_progress", "done", "todo"]);
  await laneAction(page, "Ready for work", "Remove");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await getBoard()).cards).toEqual(original.cards);
  await laneAction(page, "Ready for work", "Remove");
  await dialog.getByRole("button", { name: "Remove lane", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(headings(page)).toHaveText(["Done"]);
  expect((await getBoard()).cards).toEqual(original.cards);
  await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
  await dialog.getByRole("button", { name: "Add Ready for work lane", exact: true }).click();
  await dialog.getByRole("button", { name: "Save board", exact: true }).click();
  await expect(headings(page)).toHaveText(["Done", "Ready for work"]);
  const custom = `custom_${randomUUID()}`;
  expect((await page.request.patch(endpoint, { headers, data: { lanes: [custom], customLanes: [{ value: custom, label: "Review" }] } })).ok()).toBeTruthy();
  await page.reload();
  await laneAction(page, "Review", "Rename");
  await dialog.getByLabel("Lane name", { exact: true }).fill("Quality review");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("button", { name: "Quality review lane actions", exact: true }).click();
  for (const action of ["Remove", "Move to left", "Move to right"]) await expect(menu(page, "Quality review").getByRole("menuitem", { name: action, exact: true })).toHaveAttribute("aria-disabled", "true");
});

test("archived boards allow hiding but disable shared lane menu actions", async ({ page, baseURL }) => {
  await fixture(page, baseURL!);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive project", exact: true }).click();
  await page.getByRole("button", { name: "Todo lane actions", exact: true }).click();
  for (const action of ["Rename", "Remove", "Move to left", "Move to right"]) await expect(menu(page, "Todo").getByRole("menuitem", { name: action, exact: true })).toHaveAttribute("aria-disabled", "true");
  await menu(page, "Todo").getByRole("menuitem", { name: "Hide", exact: true }).click();
  await expect(headings(page)).toHaveText(["In progress", "Done"]);
  await page.getByRole("button", { name: "Hidden lanes (1)", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show Todo", exact: true }).click();
  await expect(headings(page)).toHaveText(["Todo", "In progress", "Done"]);
});
