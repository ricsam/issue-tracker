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
const card = (page: Page, issue: Issue) => page.locator(".board-card").filter({ has: page.locator(`a[data-issue-id="${issue.id}"]`) });
const column = (page: Page, name: string) => page.locator(".board-column").filter({ has: page.getByRole("heading", { name: new RegExp(`^${name} \\d`) }) });
async function fixture(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { project }: { project: Project } = await (await page.request.post("/api/projects", { headers, data: { name: `Improvements ${randomUUID()}` } })).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  const issues: Issue[] = [];
  for (let index = 0; index < 6; index++) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Filter card ${index}`, labels: index % 2 ? ["bug"] : ["feature"] } })).json();
    issues.push(issue);
  }
  await page.request.post(`${endpoint}/issues`, { headers, data: { issueIds: issues.slice(0, 5).map((issue) => issue.id), lane: "todo" } });
  await page.request.post(`${endpoint}/issues`, { headers, data: { issueIds: [issues[5].id], lane: "done" } });
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card")).toHaveCount(6);
  return { issues, endpoint, headers };
}

test("empty and short lane targets stretch to tallest lane and accept low drops", async ({ page, baseURL }) => {
  // Keep both the handle and the bottom drop point within the viewport.
  await page.setViewportSize({ width: 1600, height: 1600 });
  const { issues } = await fixture(page, baseURL!);
  const boxes = await page.locator(".board-column").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
  expect(boxes[0]).toBeGreaterThan(400);
  const empty = column(page, "In progress");
  const box = (await empty.boundingBox())!;
  await card(page, issues[0]).locator(".board-card-handle").dragTo(empty, { targetPosition: { x: 40, y: box.height - 15 } });
  await expect(empty.locator(".board-card")).toHaveCount(1);
  const short = column(page, "Done");
  await card(page, issues[1]).locator(".board-card-handle").dragTo(short, { targetPosition: { x: 40, y: (await short.boundingBox())!.height - 15 } });
  await expect(short.locator(".board-card")).toHaveCount(2);
});

test("board close preserves placement and failed selection, then retries only open issues", async ({ page, baseURL }) => {
  const { issues, endpoint } = await fixture(page, baseURL!);
  const original = (await (await page.request.get(endpoint)).json()).board;
  await card(page, issues[0]).getByRole("checkbox").check();
  await card(page, issues[1]).getByRole("checkbox").check();
  await page.route(`**/api/issues/${issues[1].id}`, (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 409, json: { error: "Close blocked" } }) : route.continue());
  await page.getByRole("button", { name: "Close selected issues", exact: true }).click();
  await expect(card(page, issues[0])).toContainText("Closed");
  await expect(card(page, issues[0]).getByRole("checkbox")).not.toBeChecked();
  await expect(card(page, issues[1]).getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("alert")).toContainText("Close blocked");
  expect((await (await page.request.get(endpoint)).json()).board).toEqual(original);
  await page.unroute(`**/api/issues/${issues[1].id}`);
  await page.getByRole("button", { name: "Close selected issues", exact: true }).click();
  await expect(card(page, issues[1])).toContainText("Closed");
  await page.reload();
  await expect(card(page, issues[0])).toContainText("Closed");
  expect((await (await page.request.get(endpoint)).json()).board).toEqual(original);
});

test("combined filters prune selection and never mutate board persistence", async ({ page, baseURL }) => {
  const { issues, endpoint, headers } = await fixture(page, baseURL!);
  expect((await page.request.post("/api/issues/tagged-users", { headers, data: { issueIds: [issues[1].id], userIds: [issues[1].authorId] } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/issues/${issues[1].id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.reload();
  const original = (await (await page.request.get(endpoint)).json()).board;
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.getByRole("button", { name: "Select visible issues", exact: true }).click();
  await page.getByLabel("Filter board state").selectOption("closed");
  await page.getByLabel("Filter board lane").selectOption("todo");
  await page.getByLabel("Filter board tags", { exact: true }).selectOption(["bug"]);
  await page.getByLabel("Filter board tagged users").selectOption([issues[1].authorId]);
  await page.getByLabel("Filter board creator").selectOption(issues[1].authorId);
  await page.getByRole("textbox", { name: "Search issues" }).fill(`!${issues[1].number}`);
  await expect(page.locator(".board-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Select visible issues", exact: true }).click();
  await expect(page.locator(".issue-selection-count")).toHaveText("1 selected");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(6);
  await expect(page.locator(".issue-selection-count")).toHaveText("0 selected");
  expect(writes).toEqual([]);
  expect((await (await page.request.get(endpoint)).json()).board).toEqual(original);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Filter board state")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("closing a selected draft requires confirmation and locks board changes while pending", async ({ page, baseURL }) => {
  const { issues } = await fixture(page, baseURL!);
  await card(page, issues[0]).getByRole("link").click();
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  const editor = page.getByRole("complementary", { name: "Issue details", exact: true }).getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Keep unsaved draft");
  await card(page, issues[0]).getByRole("checkbox").check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close selected issues", exact: true }).click();
  await expect(editor).toContainText("Keep unsaved draft");
  await expect(card(page, issues[0])).not.toContainText("Closed");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/issues/${issues[0].id}`, async (route) => {
    if (route.request().method() === "PATCH") await blocked;
    await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close selected issues", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage lanes", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add issues", exact: true })).toBeDisabled();
  await expect(card(page, issues[1]).locator(".board-card-handle")).toHaveAttribute("draggable", "false");
  release();
  await expect(card(page, issues[0])).toContainText("Closed");
});
