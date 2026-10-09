import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import type { BoardSettings, Issue, Project } from "../shared/types";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });
const modal = (page: Page) => page.getByRole("dialog", { name: "Send to board", exact: true });
const actions = (page: Page) => page.getByRole("group", { name: "Selected issue actions", exact: true });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Issue details", exact: true });
async function post<T>(page: Page, origin: string, path: string, data: unknown, method = "POST"): Promise<T> {
  const response = await page.request.fetch(path, { method, headers: { Origin: origin }, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const createProject = async (page: Page, origin: string, name: string) => (await post<{ project: Project }>(page, origin, "/api/projects", { name })).project;
const createIssue = async (page: Page, origin: string, projectId: string | null, body: string) => (await post<{ issue: Issue }>(page, origin, "/api/issues", { projectId, body })).issue;
const boardPath = (project: Project) => `/api/projects/${project.slug}/board`;
const board = async (page: Page, project: Project): Promise<BoardSettings> => (await (await page.request.get(boardPath(project))).json()).board;
async function selectIssue(page: Page, issue: Issue) { await page.locator(".issue-row").filter({ has: page.locator(`a[data-issue-id="${issue.id}"]`) }).getByRole("checkbox").check(); }
async function submit(page: Page, count: number) {
  await modal(page).getByRole("button", { name: /^(Send to board|Send \d+ remaining to board)$/ }).click();
  await expect(modal(page).getByRole("status").filter({ hasText: /sent to board\./ })).toContainText(`${count} issue`);
}

test("list selection spans pages, adds and moves work to visible custom lanes, and keeps detail drafts", async ({ page, baseURL }) => {
  const p = await createProject(page, baseURL!, `Placement ${randomUUID()}`);
  const issues: Issue[] = [];
  for (let n = 1; n <= 12; n++) issues.push(await createIssue(page, baseURL!, p.id, `Task ${n}`));
  await post(page, baseURL!, `${boardPath(p)}/issues`, { issueIds: [issues[0].id], lane: "todo" });
  const review = `custom_${randomUUID()}`;
  await post(page, baseURL!, boardPath(p), { lanes: ["in_progress", review, "done"], customLanes: [{ value: review, label: "Review" }] }, "PATCH");
  await page.goto(`/projects/${p.slug}`);
  await page.getByRole("combobox", { name: "Rows per page" }).selectOption("10");
  await page.locator(`a[data-issue-id="${issues[0].id}"]`).click();
  const editor = sidebar(page).getByRole("textbox", { name: "Issue", exact: true });
  await sidebar(page).locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Keep this unsaved body");
  await sidebar(page).locator(".comments [contenteditable=true]").fill("Keep this unsent comment");
  await selectIssue(page, issues[0]);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await selectIssue(page, issues[10]);
  await expect(actions(page)).toContainText("2 selected");
  await actions(page).getByRole("button", { name: "Send to board", exact: true }).click();
  const lane = modal(page).getByRole("combobox", { name: `Lane for ${p.name}`, exact: true });
  await expect(lane.locator("option")).toHaveText(["In progress", "Review", "Done"]);
  await lane.selectOption(review);
  await submit(page, 2);
  expect((await board(page, p)).cards).toEqual([{ issueId: issues[0].id, lane: review }, { issueId: issues[10].id, lane: review }]);
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toContainText("Keep this unsaved body");
  await expect(sidebar(page).locator(".comments [contenteditable=true]")).toContainText("Keep this unsent comment");
  await expect(actions(page)).toContainText("0 selected");
  const detail = await (await page.request.get(`/api/issues/${issues[0].id}`)).json();
  expect(detail.issue.body).toBe(issues[0].body);
  expect(detail.issue.updatedAt).toBe(issues[0].updatedAt);
  expect(detail.comments).toEqual([]);
  // Discard only when explicitly closing the old draft, then verify the parent board cache.
  page.once("dialog", (prompt) => prompt.accept());
  await sidebar(page).getByRole("button", { name: "Close issue details" }).click();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-column").filter({ has: page.getByRole("heading", { name: /Review/ }) }).locator(".board-card")).toHaveCount(2);
});

test("All issues sends to each corresponding project, leaves unlinked issues selected, and retries only failures", async ({ page, baseURL }) => {
  const marker = `Mixed ${randomUUID()}`;
  const a = await createProject(page, baseURL!, `${marker} Alpha`);
  const b = await createProject(page, baseURL!, `${marker} Beta`);
  const one = await createIssue(page, baseURL!, a.id, `${marker} one`);
  const two = await createIssue(page, baseURL!, b.id, `${marker} two`);
  const unlinked = await createIssue(page, baseURL!, null, `${marker} unlinked`);
  const custom = `custom_${randomUUID()}`;
  await post(page, baseURL!, boardPath(b), { lanes: [custom], customLanes: [{ value: custom, label: "Ready for QA" }] }, "PATCH");
  await page.goto("/issues");
  await page.getByRole("textbox", { name: "Search issues" }).fill(marker);
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).check();
  await actions(page).getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal(page)).toContainText("1 issue will not be sent");
  await modal(page).getByRole("combobox", { name: `Lane for ${a.name}`, exact: true }).selectOption("in_progress");
  await expect(modal(page).getByRole("combobox", { name: `Lane for ${b.name}`, exact: true })).toHaveValue(custom);
  const requests: string[] = [];
  page.on("request", (request) => { if (request.method() === "PUT") requests.push(new URL(request.url()).pathname); });
  await page.route(`**${boardPath(b)}/issues`, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: "Please retry Beta" } }) : route.continue());
  await submit(page, 1);
  await expect(modal(page).getByRole("alert")).toContainText("Please retry Beta");
  expect((await board(page, a)).cards).toEqual([{ issueId: one.id, lane: "in_progress" }]);
  expect((await board(page, b)).cards).toEqual([]);
  await page.unroute(`**${boardPath(b)}/issues`);
  await modal(page).getByRole("button", { name: "Send 1 remaining to board" }).click();
  await expect(modal(page).getByText("Sent to Ready for QA.", { exact: true })).toBeVisible();
  expect(requests.filter((path) => path === `${boardPath(a)}/issues`)).toHaveLength(1);
  expect(requests.filter((path) => path === `${boardPath(b)}/issues`)).toHaveLength(2);
  expect((await board(page, b)).cards).toEqual([{ issueId: two.id, lane: custom }]);
  await page.screenshot({ path: "test-results/send-to-board-mixed.png" });
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(actions(page)).toContainText("1 selected");
  await expect(page.locator(".issue-row").filter({ has: page.locator(`a[data-issue-id="${unlinked.id}"]`) }).getByRole("checkbox")).toBeChecked();
});

for (const width of [1440, 390]) {
  test(`issue details send and move directly without saving at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 950 });
    const p = await createProject(page, baseURL!, `Details ${randomUUID()}`);
    const issue = await createIssue(page, baseURL!, p.id, "Persisted body #keep");
    await page.goto(`/issues/${issue.id}`);
    const editor = page.getByRole("textbox", { name: "Issue", exact: true });
    await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
    await editor.fill("Unsaved detail draft");
    await page.getByRole("button", { name: "Send to board", exact: true }).click();
    await modal(page).getByRole("combobox", { name: `Lane for ${p.name}` }).selectOption("in_progress");
    await submit(page, 1);
    await modal(page).getByRole("button", { name: "Done", exact: true }).click();
    await expect(editor).toContainText("Unsaved detail draft");
    await expect(page.getByText("Board placement updated", { exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.body).toBe(issue.body);
    await page.getByRole("button", { name: "Send to board", exact: true }).click();
    const lane = modal(page).getByRole("combobox", { name: `Lane for ${p.name}` });
    await expect(lane).toHaveValue("in_progress");
    await lane.selectOption("done");
    await page.screenshot({ path: `test-results/send-to-board-detail-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await submit(page, 1);
    expect((await board(page, p)).cards).toEqual([{ issueId: issue.id, lane: "done" }]);
    await modal(page).getByRole("button", { name: "Done", exact: true }).click();
    await expect(editor).toContainText("Unsaved detail draft");
  });
}

test("closed off-board and unlinked issues explain why they cannot be sent; archived details stay read-only", async ({ page, baseURL }) => {
  const p = await createProject(page, baseURL!, `Closed ${randomUUID()}`);
  const member = await createIssue(page, baseURL!, p.id, "Closed on board");
  const backlog = await createIssue(page, baseURL!, p.id, "Closed off board");
  const unlinked = await createIssue(page, baseURL!, null, "No board available");
  await post(page, baseURL!, `${boardPath(p)}/issues`, { issueIds: [member.id], lane: "todo" });
  for (const issue of [member, backlog]) await post(page, baseURL!, `/api/issues/${issue.id}`, { state: "closed" }, "PATCH");
  await page.goto(`/projects/${p.slug}?state=closed`);
  await page.getByRole("checkbox", { name: "Select all issues on this page" }).check();
  await actions(page).getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal(page)).toContainText("1 closed issue is not on this board");
  await modal(page).getByRole("combobox", { name: `Lane for ${p.name}` }).selectOption("done");
  await submit(page, 1);
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(actions(page)).toContainText("1 selected");
  expect((await board(page, p)).cards).toEqual([{ issueId: member.id, lane: "done" }]);
  await page.goto(`/issues/${backlog.id}`);
  await page.getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal(page)).toContainText("Reopen it before adding");
  await expect(modal(page).getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await page.goto(`/issues/${unlinked.id}`);
  await expect(page.getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  await post(page, baseURL!, `/api/projects/${p.slug}`, { archived: true }, "PATCH");
  await page.goto(`/issues/${member.id}`);
  await expect(page.getByText(/belongs to an archived project/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to board", exact: true })).toHaveCount(0);
});

test("embedded detail placement updates the board immediately and stale destinations can reload", async ({ page, baseURL }) => {
  const p = await createProject(page, baseURL!, `Live board ${randomUUID()}`);
  const issue = await createIssue(page, baseURL!, p.id, "Move from detail");
  await post(page, baseURL!, `${boardPath(p)}/issues`, { issueIds: [issue.id], lane: "todo" });
  await page.goto(`/projects/${p.slug}/board`);
  await page.locator(".board-card").getByRole("link", { name: issue.title, exact: true }).click();
  const editor = sidebar(page).getByRole("textbox", { name: "Issue", exact: true });
  await sidebar(page).locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Draft remains on the board");
  await sidebar(page).getByRole("button", { name: "Send to board", exact: true }).click();
  const lane = modal(page).getByRole("combobox", { name: `Lane for ${p.name}` });
  await lane.selectOption("in_progress");
  // Another teammate hides the selected destination before submission.
  await post(page, baseURL!, boardPath(p), { lanes: ["todo", "done"] }, "PATCH");
  await modal(page).getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal(page).getByRole("alert")).toContainText("Destination lane is hidden");
  expect((await board(page, p)).cards).toEqual([{ issueId: issue.id, lane: "todo" }]);
  await modal(page).getByRole("button", { name: `Reload lanes for ${p.name}` }).click();
  await expect(lane.locator("option")).toHaveText(["Todo", "Done"]);
  await lane.focus();
  await lane.press("End");
  await expect(lane).toHaveValue("done");
  await submit(page, 1);
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toContainText("Draft remains on the board");
  await expect(page.locator(".board-column").filter({ has: page.getByRole("heading", { name: /Done/ }) }).locator(".board-card")).toHaveCount(1);
  await expect(page.locator(".board-column")).toHaveCount(2);
});

test("lane loading can retry, pending placement is locked, and counts failures never retry a committed write", async ({ page, baseURL }) => {
  const p = await createProject(page, baseURL!, `Retry ${randomUUID()}`);
  const issue = await createIssue(page, baseURL!, p.id, "Retry placement");
  await page.goto(`/issues/${issue.id}`);
  await page.route(`**${boardPath(p)}`, (route) => route.fulfill({ status: 500, json: { error: "Lane load failed" } }));
  await page.getByRole("button", { name: "Send to board", exact: true }).click();
  await expect(modal(page).getByRole("alert")).toContainText("Lane load failed");
  await expect(modal(page).getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  await page.unroute(`**${boardPath(p)}`);
  await modal(page).getByRole("button", { name: `Reload lanes for ${p.name}` }).click();
  await modal(page).getByRole("combobox", { name: `Lane for ${p.name}` }).selectOption("todo");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  await page.route(`**${boardPath(p)}/issues`, async (route) => { if (route.request().method() === "PUT") { writes++; await gate; } await route.continue(); });
  await page.route("**/api/projects", (route) => route.fulfill({ status: 500, json: { error: "Counts unavailable" } }));
  try {
    await modal(page).getByRole("button", { name: "Send to board", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Sending…" })).toBeDisabled();
    await expect(modal(page).getByRole("combobox")).toBeDisabled();
    await page.keyboard.press("Escape");
    await modal(page).getByRole("button", { name: "Close dialog" }).click();
    await expect(modal(page)).toBeVisible();
    expect(writes).toBe(1);
  } finally { release(); }
  await expect(modal(page).getByRole("alert")).toContainText("Board updated, but workspace counts could not refresh: Counts unavailable");
  await expect(modal(page).getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  expect(writes).toBe(1);
  expect((await board(page, p)).cards).toEqual([{ issueId: issue.id, lane: "todo" }]);
});
