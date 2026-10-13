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
async function write<T>(page: Page, origin: string, path: string, data: unknown, method = "POST"): Promise<T> {
  const response = await page.request.fetch(path, { method, headers: { Origin: origin }, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(page: Page, origin: string) {
  const project = (await write<{ project: Project }>(page, origin, "/api/projects", { name: `Placement controls ${randomUUID()}` })).project;
  const issue = (await write<{ issue: Issue }>(page, origin, "/api/issues", { projectId: project.id, body: "Placement control issue" })).issue;
  const custom = `custom_${randomUUID()}`;
  await write(page, origin, `/api/projects/${project.slug}/board`, { lanes: ["todo", custom], customLanes: [{ value: custom, label: "Ready for review" }] }, "PATCH");
  return { project, issue, custom };
}
const getBoard = async (page: Page, project: Project): Promise<BoardSettings> => (await (await page.request.get(`/api/projects/${project.slug}/board`)).json()).board;
async function selectLane(page: Page, lane: string) {
  await page.getByRole("button", { name: "Change board lane", exact: true }).click();
  await page.getByRole("combobox", { name: "Board lane", exact: true }).selectOption(lane);
}

test("custom lane, removal and project move are immediate and preserve draft body", async ({ page, baseURL }) => {
  const { project, issue, custom } = await seed(page, baseURL!);
  await page.goto(`/issues/${issue.id}`);
  const editor = page.locator(".detail-form").getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Unsaved placement draft");
  await expect(page.getByRole("button", { name: "Change project", exact: true })).toContainText(project.name);
  await selectLane(page, custom);
  await expect(page.getByRole("button", { name: "Change board lane", exact: true })).toContainText("Ready for review");
  expect((await getBoard(page, project)).cards).toEqual([{ issueId: issue.id, lane: custom }]);
  await expect(editor).toContainText("Unsaved placement draft");
  await selectLane(page, "");
  await expect(page.getByRole("button", { name: "Change board lane", exact: true })).toContainText("No board lane");
  expect((await getBoard(page, project)).cards).toEqual([]);
  await selectLane(page, "todo");
  await expect(page.getByRole("button", { name: "Change board lane", exact: true })).toContainText("Todo");
  await page.getByRole("button", { name: "Change project", exact: true }).click();
  await expect(page.getByText("Choosing a project immediately removes placement", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("");
  await expect(page.getByRole("button", { name: "Change project", exact: true })).toContainText("No project");
  await expect(page.getByRole("button", { name: "Change board lane", exact: true })).toBeDisabled();
  await expect(editor).toContainText("Unsaved placement draft");
  expect((await getBoard(page, project)).cards).toEqual([]);
  const persisted = (await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue as Issue;
  expect(persisted.projectId).toBeNull();
  expect(persisted.body).toBe(issue.body);
});

test("board loading can retry and closed off-board issues cannot be added", async ({ page, baseURL }) => {
  const { project, issue } = await seed(page, baseURL!);
  const path = `**/api/projects/${project.slug}/board`;
  await page.route(path, (route) => route.fulfill({ status: 503, json: { error: "Board temporarily unavailable" } }));
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Change board lane", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Board temporarily unavailable");
  await page.unroute(path);
  await page.getByRole("button", { name: "Retry loading board lanes", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Board lane", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await write(page, baseURL!, `/api/issues/${issue.id}`, { state: "closed" }, "PATCH");
  await page.reload();
  await page.getByRole("button", { name: "Change board lane", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Board lane", exact: true })).toBeDisabled();
  await expect(page.getByText("Reopen this closed issue before adding it to the board.", { exact: true })).toBeVisible();
  expect((await getBoard(page, project)).cards).toEqual([]);
});
