import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { Issue, Project } from "../shared/types";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });
const column = (page: Page, name: string) => page.locator(".board-column").filter({ has: page.getByRole("heading", { name: new RegExp(`^${name} \\d`) }) });
const card = (page: Page, issue: Issue) => page.locator(".board-card").filter({ has: page.locator(`a[data-issue-id="${issue.id}"]`) });
const order = (page: Page, lane: string) => column(page, lane).locator(".board-card .issue-number");
const numbers = (values: number[]) => values.map((value) => `#${value}`);
async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { project }: { project: Project } = await (await page.request.post("/api/projects", { headers, data: { name: `Order ${randomUUID()}` } })).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  const issues: Issue[] = [];
  for (let number = 1; number <= 6; number++) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `${number % 2 ? "Visible" : "Hidden"} card ${number}` } })).json();
    issues.push(issue);
  }
  expect((await page.request.post(`${endpoint}/issues`, { headers, data: { issueIds: issues.slice(0, 5).map((issue) => issue.id), lane: "todo" } })).ok()).toBeTruthy();
  expect((await page.request.post(`${endpoint}/issues`, { headers, data: { issueIds: [issues[5].id], lane: "done" } })).ok()).toBeTruthy();
  await page.goto(`/projects/${project.slug}/board`);
  await expect(order(page, "Todo")).toHaveText(numbers([1, 2, 3, 4, 5]));
  return { project, issues, endpoint, headers };
}
async function dragCard(page: Page, source: Issue, target: Issue, after = false) {
  const box = await card(page, target).boundingBox();
  await card(page, source).locator(".board-card-handle").dragTo(card(page, target), { targetPosition: { x: 30, y: after ? box!.height - 6 : 6 } });
}
async function menuMove(page: Page, issue: Issue, name: string) {
  await page.getByRole("button", { name: `Board actions for issue #${issue.number}`, exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("drag places cards before and after siblings, persists across reload, and preserves issue drafts", async ({ page, baseURL }) => {
  const { issues, endpoint } = await fixture(page, baseURL!);
  await dragCard(page, issues[4], issues[1]);
  await expect(order(page, "Todo")).toHaveText(numbers([1, 5, 2, 3, 4]));
  await dragCard(page, issues[0], issues[2], true);
  await expect(order(page, "Todo")).toHaveText(numbers([5, 2, 3, 1, 4]));
  await page.reload();
  await expect(order(page, "Todo")).toHaveText(numbers([5, 2, 3, 1, 4]));
  const saved = (await (await page.request.get(endpoint)).json()).board;
  expect(saved.cards.filter((item: { lane: string }) => item.lane === "todo").map((item: { issueId: string }) => item.issueId)).toEqual([4, 1, 2, 0, 3].map((index) => issues[index].id));
  await card(page, issues[0]).getByRole("link").click();
  const editor = page.getByRole("complementary", { name: "Issue details", exact: true }).getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Keep this unsaved text");
  await menuMove(page, issues[0], "Move to top");
  await expect(order(page, "Todo")).toHaveText(numbers([1, 5, 2, 3, 4]));
  await expect(editor).toContainText("Keep this unsaved text");
  expect((await (await page.request.get(`/api/issues/${issues[0].id}`)).json()).issue).toEqual(issues[0]);
});

test("selected cards move as an ordered block across lanes and filtered reordering keeps hidden cards", async ({ page, baseURL }) => {
  const { issues, endpoint } = await fixture(page, baseURL!);
  await card(page, issues[1]).getByRole("checkbox").check();
  await card(page, issues[3]).getByRole("checkbox").check();
  await dragCard(page, issues[3], issues[5]);
  await expect(order(page, "Done")).toHaveText(numbers([2, 4, 6]));
  await expect(order(page, "Todo")).toHaveText(numbers([1, 3, 5]));
  await expect(page.locator(".board-card.is-bulk-selected")).toHaveCount(0);
  await card(page, issues[1]).getByRole("checkbox").check();
  await card(page, issues[3]).getByRole("checkbox").check();
  await card(page, issues[1]).locator(".board-card-handle").dragTo(column(page, "Todo"), { targetPosition: { x: 20, y: (await column(page, "Todo").boundingBox())!.height - 5 } });
  await expect(order(page, "Todo")).toHaveText(numbers([1, 3, 5, 2, 4]));
  await page.getByRole("textbox", { name: "Search issues" }).fill("Visible");
  await dragCard(page, issues[0], issues[4], true);
  await expect(order(page, "Todo")).toHaveText(numbers([3, 5, 1]));
  await page.getByRole("textbox", { name: "Search issues" }).fill("");
  await expect(order(page, "Todo")).toHaveText(numbers([3, 5, 1, 2, 4]));
  expect((await (await page.request.get(endpoint)).json()).board.cards.filter((item: { lane: string }) => item.lane === "todo")).toHaveLength(5);
});

for (const width of [1440, 390]) {
  test(`menu ordering works with keyboard and mobile controls at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { issues } = await fixture(page, baseURL!);
    const trigger = page.getByRole("button", { name: "Board actions for issue #3", exact: true });
    await trigger.focus();
    await trigger.press("Enter");
    const up = page.getByRole("menuitem", { name: "Move up", exact: true });
    await up.focus();
    await up.press("Enter");
    await expect(order(page, "Todo")).toHaveText(numbers([1, 3, 2, 4, 5]));
    await menuMove(page, issues[2], "Move down");
    await expect(order(page, "Todo")).toHaveText(numbers([1, 2, 3, 4, 5]));
    await menuMove(page, issues[2], "Move to bottom");
    await expect(order(page, "Todo")).toHaveText(numbers([1, 2, 4, 5, 3]));
    await menuMove(page, issues[2], "Move to top");
    await expect(order(page, "Todo")).toHaveText(numbers([3, 1, 2, 4, 5]));
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.screenshot({ path: `test-results/board-order-menu-${width}.png` });
    await page.keyboard.press("Escape");
    await card(page, issues[0]).getByRole("checkbox").check();
    await card(page, issues[1]).getByRole("checkbox").check();
    await page.getByRole("button", { name: "Selected board issue actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to bottom", exact: true }).click();
    await expect(order(page, "Todo")).toHaveText(numbers([3, 4, 5, 1, 2]));
    await page.reload();
    await expect(order(page, "Todo")).toHaveText(numbers([3, 4, 5, 1, 2]));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) {
      // Lane-menu moves must append a multi-selection in its manual order, not issue-number order.
      await card(page, issues[2]).getByRole("checkbox").check();
      await card(page, issues[0]).getByRole("checkbox").check();
      await page.getByRole("button", { name: "Selected board issue actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Done", exact: true }).click();
      await expect(order(page, "Done")).toHaveText(numbers([6, 3, 1]));
    }
  });
}

test("failed reorders retain selection/order for retry and closed cards stay reorderable until archived", async ({ page, baseURL }) => {
  const { project, issues, endpoint, headers } = await fixture(page, baseURL!);
  await page.request.patch(`/api/issues/${issues[2].id}`, { headers, data: { state: "closed" } });
  await page.reload();
  await card(page, issues[2]).getByRole("checkbox").check();
  await page.route(`**${endpoint}/issues/reorder`, (route) => route.fulfill({ status: 409, json: { error: "Destination changed" } }));
  await menuMove(page, issues[2], "Move to top");
  await expect(page.getByRole("alert")).toContainText("Destination changed");
  await expect(order(page, "Todo")).toHaveText(numbers([1, 2, 3, 4, 5]));
  await expect(card(page, issues[2]).getByRole("checkbox")).toBeChecked();
  await page.unroute(`**${endpoint}/issues/reorder`);
  await menuMove(page, issues[2], "Move to top");
  await expect(order(page, "Todo")).toHaveText(numbers([3, 1, 2, 4, 5]));
  await expect(card(page, issues[2])).toContainText("Closed");
  await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } });
  await page.reload();
  await expect(page.getByRole("button", { name: "Board actions for issue #3", exact: true })).toBeDisabled();
  await expect(card(page, issues[2]).locator(".board-card-handle")).toHaveAttribute("draggable", "false");
});
