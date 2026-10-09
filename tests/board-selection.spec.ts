import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { Issue } from "../shared/types";

async function seed(page: Page, baseURL: string, count = 4) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Selection ${randomUUID()}` } })).json();
  const issues: Issue[] = [];
  for (let n = 1; n <= count; n++) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Selection issue ${n}\n\nKeep my text #design` } })).json();
    issues.push(issue);
  }
  const endpoint = `/api/projects/${project.slug}/board`;
  expect((await page.request.post(`${endpoint}/issues`, { headers, data: { issueIds: issues.map((i) => i.id), lane: "todo" } })).ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}/board`);
  return { project, issues, endpoint, headers };
}
const column = (page: Page, label: string) => page.locator(".board-column").filter({ has: page.getByRole("heading", { name: new RegExp(`^${label}`) }) });
const select = (page: Page, n: number) => page.getByRole("checkbox", { name: `Select issue !${n}`, exact: true });

for (const width of [1440, 1060, 390]) {
  test(`board selection bar is permanent, compact and stable at ${width}px`, async ({ page, baseURL }) => {
    const { project, issues, endpoint, headers } = await seed(page, baseURL!, 12);
    await page.setViewportSize({ width, height: 1000 });
    const bar = page.getByRole("group", { name: "Selected board issue actions", exact: true });
    const board = page.locator(".board");
    const selectAll = bar.getByRole("button", { name: "Select visible issues", exact: true });
    const actions = [
      bar.getByRole("button", { name: "Selected board issue actions", exact: true }),
      bar.getByRole("button", { name: "Tag selected issues", exact: true }),
      bar.getByRole("button", { name: "Add tags", exact: true }),
      bar.getByRole("button", { name: "Clear selection", exact: true }),
    ];
    const offset = () => board.evaluate((element) => element.getBoundingClientRect().top - element.parentElement!.querySelector(".issue-board-actions")!.getBoundingClientRect().top);
    await expect(bar.getByText("12 of 12 issues assigned to board · 0 unassigned · 3 lanes", { exact: true })).toBeVisible();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    await expect(page.getByText("Use checkboxes or Shift-click to select a range.", { exact: true })).toHaveCount(0);
    await expect(selectAll).toBeEnabled();
    for (const action of actions) await expect(action).toBeDisabled();
    for (const action of [selectAll, ...actions]) expect((await action.boundingBox())!.height).toBe(28);
    const height = (await bar.boundingBox())!.height;
    const initialOffset = await offset();
    expect(initialOffset - height).toBe(8);
    await bar.screenshot({ path: `test-results/board-selection-empty-${width}.png` });
    await select(page, issues[0].number).check();
    await expect(bar.getByText("1 selected", { exact: true })).toBeVisible();
    for (const action of actions) await expect(action).toBeEnabled();
    expect((await bar.boundingBox())!.height).toBe(height);
    expect(await offset()).toBe(initialOffset);
    await selectAll.click();
    await expect(bar.getByText("12 selected", { exact: true })).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(height);
    expect(await offset()).toBe(initialOffset);
    await bar.screenshot({ path: `test-results/board-selection-selected-${width}.png` });
    await actions[3].click();
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(height);
    expect(await offset()).toBe(initialOffset);
    for (const action of actions) await expect(action).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    // Hidden/search-filtered cards are not selected, but the total status remains.
    await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("issue 12");
    await selectAll.click();
    await expect(bar.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(select(page, issues[11].number)).toBeChecked();
    await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("missing");
    await expect(bar.getByText("0 selected", { exact: true })).toBeVisible();
    await expect(selectAll).toBeDisabled();
    for (const action of actions) await expect(action).toBeDisabled();
    await expect(bar).toContainText("12 of 12 issues assigned to board · 0 unassigned · 3 lanes");
    expect((await bar.boundingBox())!.height).toBe(height);
    await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
    expect((await page.request.patch(endpoint, { headers, data: { lanes: ["in_progress", "done"] } })).ok()).toBeTruthy();
    await page.reload();
    await expect(bar).toContainText("12 of 12 issues assigned to board · 0 unassigned · 2 lanes · 12 issues in hidden lanes");
    await expect(selectAll).toBeDisabled();
    expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
    await page.reload();
    await expect(bar).toBeVisible();
    for (const action of [selectAll, ...actions]) await expect(action).toBeDisabled();
    const { project: empty } = await (await page.request.post("/api/projects", { headers, data: { name: `Empty board ${randomUUID()}` } })).json();
    await page.goto(`/projects/${empty.slug}/board`);
    await expect(bar).toContainText("0 of 0 issues assigned to board · 0 unassigned · 3 lanes");
    await expect(page.getByText("No work on the board yet.", { exact: false })).toBeVisible();
    for (const action of [selectAll, ...actions]) await expect(action).toBeDisabled();
  });
}

for (const width of [1440, 390]) {
  test(`board move notifications do not shift lanes at ${width}px`, async ({ page, baseURL }) => {
    const { issues } = await seed(page, baseURL!, 3);
    await page.setViewportSize({ width, height: 1000 });
    const board = page.locator(".board");
    const offset = () => board.evaluate((element) => element.getBoundingClientRect().top - element.parentElement!.querySelector(".issue-board-actions")!.getBoundingClientRect().top);
    const initialOffset = await offset();
    await page.getByRole("button", { name: `Board actions for issue !${issues[0].number}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
    const status = page.getByRole("status").filter({ hasText: "1 of 1 issues moved." });
    await expect(status).toBeVisible();
    expect(await offset()).toBe(initialOffset);
    const snackbar = page.locator(".snackbar");
    await expect(snackbar).toHaveCSS("position", "fixed");
    const bounds = (await snackbar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
    await page.screenshot({ path: `test-results/board-snackbar-${width}.png` });
    await snackbar.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(status).toHaveCount(0);
    expect(await offset()).toBe(initialOffset);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("snackbars restart for identical moves, pause for interaction, and clear when leaving the board", async ({ page, baseURL }) => {
  const { issues } = await seed(page, baseURL!);
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
  const snackbar = page.locator(".snackbar");
  const status = snackbar.getByRole("status");
  const dismiss = snackbar.getByRole("button", { name: "Dismiss notification" });
  const move = async (number: number, lane: string) => {
    await page.getByRole("button", { name: `Board actions for issue !${number}`, exact: true }).click();
    await page.getByRole("menuitem", { name: lane, exact: true }).click();
    await expect(status).toHaveText("1 of 1 issues moved.");
    await expect(column(page, lane).getByRole("checkbox", { name: `Select issue !${number}`, exact: true })).toBeVisible();
    await expect(dismiss).not.toBeFocused();
  };
  await expect(status).toBeEmpty();
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await move(issues[0].number, "In progress");
  await page.clock.fastForward(4000);
  await move(issues[1].number, "In progress");
  await page.clock.fastForward(1500);
  await expect(status).toHaveText("1 of 1 issues moved.");
  await page.clock.fastForward(3500);
  await expect(status).toBeEmpty();
  await expect(dismiss).toHaveCount(0);

  await move(issues[2].number, "In progress");
  await snackbar.hover();
  await page.clock.fastForward(6000);
  await expect(status).toHaveText("1 of 1 issues moved.");
  await dismiss.focus();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(6000);
  await expect(dismiss).toBeFocused();
  await page.getByRole("textbox", { name: "Search issues" }).focus();
  await page.clock.fastForward(5000);
  await expect(status).toBeEmpty();

  await move(issues[3].number, "In progress");
  await dismiss.focus();
  await dismiss.press("Enter");
  await expect(status).toBeEmpty();
  await move(issues[0].number, "Done");
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(snackbar).toHaveCount(0);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(status).toBeEmpty();
});

test("pending and failed moves clear stale snackbars while preserving errors and retry selection", async ({ page, baseURL }) => {
  const { endpoint, issues } = await seed(page, baseURL!);
  await page.clock.install();
  const status = page.locator(".snackbar").getByRole("status");
  const offset = () => page.locator(".board").evaluate((element) => element.getBoundingClientRect().top - element.parentElement!.querySelector(".issue-board-actions")!.getBoundingClientRect().top);
  const initialOffset = await offset();
  await page.getByRole("button", { name: `Board actions for issue !${issues[0].number}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect(status).toHaveText("1 of 1 issues moved.");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${endpoint}/issues/${issues[1].id}`, async (route) => {
    await gate;
    await route.fulfill({ status: 500, json: { error: "Move failed" } });
  });
  try {
    await select(page, issues[1].number).check();
    await page.getByRole("button", { name: `Board actions for issue !${issues[1].number}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
    await expect(status).toBeEmpty();
    expect(await offset()).toBe(initialOffset);
  } finally { release(); }
  await expect(page.getByRole("alert")).toContainText("Move failed");
  await expect(status).toHaveText("0 of 1 issues moved.");
  await expect(column(page, "Todo").getByRole("checkbox", { name: `Select issue !${issues[1].number}`, exact: true })).toBeChecked();
  await page.clock.fastForward(5000);
  await expect(status).toBeEmpty();
  await expect(page.getByRole("alert")).toContainText("Move failed");
  await page.unroute(`**${endpoint}/issues/${issues[1].id}`);
  await page.getByRole("button", { name: `Board actions for issue !${issues[1].number}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect(status).toHaveText("1 of 1 issues moved.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("only checkboxes or modifier clicks select board cards, while ordinary links and menus still work", async ({ page, baseURL, context }) => {
  const { issues } = await seed(page, baseURL!);
  const cards = page.locator(".board-card");
  const first = cards.filter({ has: select(page, issues[0].number) });
  const second = cards.filter({ has: select(page, issues[1].number) });
  const fourth = cards.filter({ has: select(page, issues[3].number) });
  const selected = page.locator(".board-card.is-bulk-selected");
  const details = page.getByRole("complementary", { name: "Issue details", exact: true });
  await expect(first).not.toHaveAttribute("draggable", "true");
  await expect(first.locator(".issue-link")).toHaveAttribute("draggable", "false");
  await first.locator(".board-card-handle").click();
  await expect(details).toHaveCount(0);
  for (const surface of [first.locator(".issue-number"), first.locator(".tag"), first.locator(".issue-link strong")]) {
    await surface.click();
    await expect(details).toContainText("Selection issue 1");
    await expect(selected).toHaveCount(0);
    await details.getByRole("button", { name: "Close issue details", exact: true }).click();
  }
  await first.click({ position: { x: 5, y: 5 } });
  await expect(details).toContainText("Selection issue 1");
  await expect(selected).toHaveCount(0);
  await details.getByRole("button", { name: "Close issue details", exact: true }).click();
  // Card bodies are not draggable; moving one leaves all placements untouched.
  await first.locator(".issue-link strong").dragTo(column(page, "Done"));
  await expect(column(page, "Todo").locator(".board-card")).toHaveCount(4);
  await expect(column(page, "Done").locator(".board-card")).toHaveCount(0);
  await select(page, issues[0].number).check();
  await expect(selected).toHaveCount(1);
  await first.locator(".issue-number").click();
  await expect(select(page, issues[0].number)).toBeChecked();
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Close issue details", exact: true }).click();

  // Cmd/Ctrl toggle from anywhere, including links, without opening another tab.
  const tabs = context.pages().length;
  await second.locator(".issue-link").click({ modifiers: ["Meta"] });
  await expect(select(page, issues[1].number)).toBeChecked();
  await expect(details).toHaveCount(0);
  expect(context.pages()).toHaveLength(tabs);
  await second.locator(".issue-number").click({ modifiers: ["Meta"] });
  await expect(select(page, issues[1].number)).not.toBeChecked();
  await second.locator(".tag").click({ modifiers: ["Control"] });
  await expect(select(page, issues[1].number)).toBeChecked();
  await second.click({ position: { x: 2, y: 2 }, modifiers: ["Control"] });
  await expect(select(page, issues[1].number)).not.toBeChecked();
  await fourth.locator(".issue-link").click({ modifiers: ["Shift"] });
  for (const number of [1, 2, 3, 4]) await expect(select(page, issues[number - 1].number)).toBeChecked();
  await expect(details).toHaveCount(0);
  expect(context.pages()).toHaveLength(tabs);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await select(page, issues[0].number).check();
  await fourth.locator(".issue-number").click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(4);

  // A modified menu-trigger click selects the card; an ordinary one opens its menu.
  const menuButton = first.getByRole("button", { name: `Board actions for issue !${issues[0].number}`, exact: true });
  await menuButton.click({ modifiers: ["Meta"] });
  await expect(select(page, issues[0].number)).not.toBeChecked();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await menuButton.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(select(page, issues[0].number)).not.toBeChecked();
});

test("board menu supports keyboard, range selection, bulk moves, drag and retryable remove", async ({ page, baseURL }) => {
  const { endpoint, issues } = await seed(page, baseURL!);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const trigger = page.getByRole("button", { name: `Board actions for issue !${issues[0].number}`, exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Todo (current lane)" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "In progress", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await select(page, issues[0].number).check();
  await select(page, issues[2].number).click({ modifiers: ["Shift"] });
  for (const n of [1, 2, 3]) await expect(select(page, issues[n - 1].number)).toBeChecked();
  await expect(select(page, issues[3].number)).not.toBeChecked();
  await trigger.click();
  await expect(page.getByRole("menu")).toContainText("Applies to 3 selected issues");
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect(column(page, "In progress").locator(".board-card")).toHaveCount(3);
  await expect(page.locator(".snackbar").getByRole("status")).toHaveText("3 of 3 issues moved.");
  await expect(page.locator(".board-card.is-bulk-selected")).toHaveCount(0);
  await select(page, issues[0].number).check();
  await select(page, issues[1].number).check();
  await page.locator(".board-card").filter({ has: select(page, issues[0].number) }).locator(".board-card-handle").dragTo(column(page, "Done"));
  await expect(column(page, "Done").locator(".board-card")).toHaveCount(2);
  await expect(column(page, "In progress").locator(".board-card")).toHaveCount(1);
  await expect(page.locator(".snackbar").getByRole("status")).toHaveText("2 issues reordered.");
  await select(page, issues[0].number).check();
  await select(page, issues[1].number).check();
  let firstDeletes = 0;
  await page.route(`**${endpoint}/issues/*`, async (route) => {
    if (route.request().method() === "DELETE") {
      if (route.request().url().endsWith(issues[0].id)) firstDeletes++;
      if (route.request().url().endsWith(issues[1].id)) return route.fulfill({ status: 500, json: { error: "Remove failed" } });
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Selected board issue actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from board" }).click();
  await expect(page.locator(".board-card")).toHaveCount(3);
  await expect(page.getByRole("alert")).toContainText("Remove failed");
  await expect(page.locator(".snackbar").getByRole("status")).toHaveText("1 of 2 issues removed from board.");
  await expect(select(page, issues[1].number)).toBeChecked();
  expect(firstDeletes).toBe(1);
  await page.unroute(`**${endpoint}/issues/*`);
  await page.getByRole("button", { name: "Selected board issue actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from board" }).click();
  await expect(page.locator(".board-card")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(2);
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("board selection prunes search-hidden issues and bulk tagging works from board and table", async ({ page, baseURL }) => {
  const { project, issues } = await seed(page, baseURL!);
  await select(page, issues[0].number).check();
  await select(page, issues[1].number).check();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("issue 4");
  await expect(page.getByRole("button", { name: "Tag selected issues" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await select(page, issues[0].number).check();
  await select(page, issues[1].number).check();
  await page.getByRole("button", { name: "Tag selected issues" }).click();
  const dialog = page.getByRole("dialog", { name: "Tag teammates" });
  await dialog.getByRole("checkbox", { name: /Alex Morgan/ }).check();
  const tagEndpoint = `/api/projects/${project.slug}/issues/tag`;
  await page.route(`**${tagEndpoint}`, (route) => route.fulfill({ status: 500, json: { error: "Tag failed" } }));
  await dialog.getByRole("button", { name: "Add mentions" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Tag failed");
  await expect(dialog.getByRole("checkbox", { name: /Alex Morgan/ })).toBeChecked();
  await page.unroute(`**${tagEndpoint}`);
  await dialog.getByRole("button", { name: "Add mentions" }).click();
  await expect(dialog).toBeHidden();
  const first = (await (await page.request.get(`/api/issues/${issues[0].id}`)).json()).issue;
  expect(first.body).toContain(issues[0].body);
  expect(first.taggedUserIds).toHaveLength(1);
  expect(first.labels).toEqual(["design"]);
  await page.getByRole("link", { name: "List", exact: true }).click();
  // Wait for the list mount rather than checking the departing board's inputs.
  const table = page.getByRole("table");
  await table.getByRole("checkbox", { name: `Select issue !${issues[0].number}`, exact: true }).check();
  await table.getByRole("checkbox", { name: `Select issue !${issues[1].number}`, exact: true }).check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: `!${issues[0].number} Selection issue 1`, exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Unsaved draft must survive cancellation");
  page.once("dialog", (prompt) => prompt.dismiss());
  await page.getByRole("button", { name: "Tag selected issues" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("Unsaved draft must survive cancellation");
  page.once("dialog", (prompt) => prompt.accept());
  await page.getByRole("button", { name: "Tag selected issues" }).click();
  await dialog.getByRole("checkbox", { name: /Alex Morgan/ }).check();
  await dialog.getByRole("button", { name: "Add mentions" }).click();
  await expect(dialog).toBeHidden();
  expect((await (await page.request.get(`/api/issues/${issues[0].id}`)).json()).issue.body).toBe(first.body);
  await expect(page.locator(".issue-row").filter({ hasText: "Selection issue 1" })).toContainText("Alex Morgan");
});
