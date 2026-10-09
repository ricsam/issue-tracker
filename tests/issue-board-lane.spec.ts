import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { Issue, Project } from "../shared/types";
import { boardLaneKey } from "../src/lib/issue-board-lanes";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });
const row = (page: Page, issue: Issue) => page.locator(".issue-row").filter({ has: page.locator(`a[data-issue-id="${issue.id}"]`) });
async function filterLane(page: Page, value: string) {
  await page.getByRole("button", { name: /^Board lane filters/ }).click();
  const popover = page.getByRole("dialog", { name: "Board lane filters", exact: true });
  await popover.getByRole("combobox", { name: "Filter by board lane" }).selectOption(value);
  await popover.getByRole("button", { name: "Done", exact: true }).click();
}
async function seed(page: Page, baseURL: string) {
  const marker = `Lanes ${randomUUID()}`;
  const headers = { Origin: baseURL };
  const p = async (suffix: string) => (await (await page.request.post("/api/projects", { headers, data: { name: `${marker} ${suffix}` } })).json()).project as Project;
  const a = await p("Alpha"), b = await p("Beta");
  const create = async (projectId: string | null, suffix: string) => (await (await page.request.post("/api/issues", { headers, data: { projectId, body: `${marker} ${suffix}` } })).json()).issue as Issue;
  const issues = [await create(a.id, "Todo"), await create(a.id, "Review"), await create(a.id, "Unplaced"), await create(b.id, "Other review"), await create(null, "Unlinked")];
  const review = `custom_${randomUUID()}`, otherReview = `custom_${randomUUID()}`;
  for (const [project, lane, issue] of [[a, review, issues[1]], [b, otherReview, issues[3]]] as const) {
    expect((await page.request.patch(`/api/projects/${project.slug}/board`, { headers, data: { lanes: ["todo", "done", lane], customLanes: [{ value: lane, label: "Review" }] } })).ok()).toBeTruthy();
    expect((await page.request.post(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [issue.id], lane } })).ok()).toBeTruthy();
  }
  await page.request.post(`/api/projects/${a.slug}/board/issues`, { headers, data: { issueIds: [issues[0].id], lane: "todo" } });
  await page.request.patch(`/api/projects/${a.slug}/board`, { headers, data: { lanes: ["todo", "done"] } });
  return { a, b, issues, review, otherReview, marker, headers };
}

for (const width of [1440, 390]) {
  test(`project list displays, sorts and filters actual board lanes including hidden lanes at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { a, issues, review, headers } = await seed(page, baseURL!);
    await page.goto(`/projects/${a.slug}`);
    await expect(row(page, issues[0]).locator(".issue-board-lane")).toHaveText("Todo");
    await expect(row(page, issues[1]).locator(".issue-board-lane")).toHaveText("Review (hidden)");
    await expect(row(page, issues[2]).locator(".issue-board-lane")).toHaveText("Not on board");
    await page.getByRole("button", { name: "Sort by board lane", exact: true }).click();
    await expect(page.locator(".issue-row .issue-number")).toHaveText(["#3", "#2", "#1"]);
    await page.getByRole("button", { name: "Sort by board lane", exact: true }).click();
    await expect(page.locator(".issue-row .issue-number")).toHaveText(["#1", "#2", "#3"]);
    await filterLane(page, boardLaneKey(a.id, review));
    await expect(page.locator(".issue-row")).toHaveCount(1);
    await expect(row(page, issues[1])).toBeVisible();
    await page.screenshot({ path: `test-results/board-lane-column-${width}.png` });
    await page.getByRole("textbox", { name: "Search issues" }).fill("Unplaced");
    await expect(page.locator(".issue-row")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search issues" }).fill("");
    await filterLane(page, "none");
    await expect(row(page, issues[2])).toBeVisible();
    await page.getByRole("button", { name: "Clear column filters" }).click();
    await expect(page.locator(".issue-row")).toHaveCount(3);
    // Closed issues retain placement, so the column does not infer it from lifecycle state.
    await page.request.patch(`/api/issues/${issues[1].id}`, { headers, data: { state: "closed" } });
    await page.goto(`/projects/${a.slug}?state=closed`);
    await expect(row(page, issues[1]).locator(".issue-board-lane")).toHaveText("Review (hidden)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("All Issues distinguishes same-named project lanes and updates its active filter after sending to board", async ({ page, baseURL }) => {
  const { a, b, issues, review, otherReview, marker, headers } = await seed(page, baseURL!);
  await page.request.patch(`/api/projects/${b.slug}`, { headers, data: { archived: true } });
  const boardRequests: string[] = [];
  page.on("request", (request) => { if (request.method() === "GET" && /\/api\/projects\/[^/]+\/board$/.test(new URL(request.url()).pathname)) boardRequests.push(request.url()); });
  await page.goto("/issues");
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await expect(page.locator(".issue-row")).toHaveCount(5);
  await expect(row(page, issues[3]).locator(".issue-board-lane")).toHaveText("Review");
  await expect(row(page, issues[3]).getByRole("checkbox")).toBeDisabled();
  await page.getByRole("button", { name: /^Board lane filters/ }).click();
  const popover = page.getByRole("dialog", { name: "Board lane filters", exact: true });
  await expect(popover.getByRole("option", { name: `${a.name} · Review (hidden)`, exact: true })).toHaveAttribute("value", boardLaneKey(a.id, review));
  await expect(popover.getByRole("option", { name: `${b.name} · Review`, exact: true })).toHaveAttribute("value", boardLaneKey(b.id, otherReview));
  await popover.getByRole("combobox").selectOption(boardLaneKey(b.id, otherReview));
  await popover.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(row(page, issues[3])).toBeVisible();
  expect(boardRequests).toEqual([]);
  await filterLane(page, "none");
  await expect(page.locator(".issue-row")).toHaveCount(2);
  await row(page, issues[2]).getByRole("checkbox").check();
  await page.getByRole("group", { name: "Selected issue actions", exact: true }).getByRole("button", { name: "Send to board", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Send to board", exact: true });
  await modal.getByRole("combobox", { name: `Lane for ${a.name}` }).selectOption("done");
  await modal.getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal).toContainText("1 issue sent to board.");
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(row(page, issues[4])).toBeVisible();
  await filterLane(page, boardLaneKey(a.id, "done"));
  await expect(row(page, issues[2]).locator(".issue-board-lane")).toHaveText("Done");
  // An embedded detail move also updates the list without reloading.
  await row(page, issues[2]).getByRole("link", { name: /#3/ }).click();
  const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
  await sidebar.getByRole("button", { name: "Send to board", exact: true }).click();
  await modal.getByRole("combobox", { name: `Lane for ${a.name}` }).selectOption("todo");
  await modal.getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal).toContainText("1 issue sent to board.");
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Close issue details" }).click();
  await page.getByRole("button", { name: "Clear column filters" }).click();
  await expect(row(page, issues[2]).locator(".issue-board-lane")).toHaveText("Todo");
});

test("project list lane reflects board add, move and removal when switching views", async ({ page, baseURL }) => {
  const { a, issues } = await seed(page, baseURL!);
  await page.goto(`/projects/${a.slug}/board`);
  await page.getByRole("button", { name: "Board actions for issue #1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(page.locator(".snackbar").getByRole("status")).toHaveText("1 of 1 issues moved.");
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(row(page, issues[0]).locator(".issue-board-lane")).toHaveText("Done");
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Board actions for issue #1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from board", exact: true }).click();
  await expect(page.locator(".snackbar").getByRole("status")).toHaveText("1 of 1 issues removed from board.");
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(row(page, issues[0]).locator(".issue-board-lane")).toHaveText("Not on board");
});
