import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { Issue } from "../shared/types";
import { extractIssueLabels } from "../shared/labels";

async function seed(page: Page, baseURL: string, count: number) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Bulk hashtags ${randomUUID()}` } })).json();
  const issues: Issue[] = [];
  for (let index = 1; index <= count; index++) {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, {
      headers, data: { body: `# Task ${index}\n\nKeep **formatting** and #existing.` },
    });
    expect(response.ok()).toBeTruthy();
    issues.push((await response.json()).issue);
  }
  await page.goto(`/projects/${project.slug}`);
  return { project, issues, headers };
}
const select = (page: Page, number: number) => page.getByRole("checkbox", { name: `Select issue #${number}`, exact: true });
const fetchIssue = async (page: Page, id: string): Promise<Issue> => (await (await page.request.get(`/api/issues/${id}`)).json()).issue;

test("bulk hashtags span pages, protect drafts, preserve latest bodies and retry without duplicates", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { project, issues, headers } = await seed(page, baseURL!, 11);
  await expect(page.getByRole("button", { name: "Add tags", exact: true })).toBeDisabled();
  await page.getByLabel("Rows per page", { exact: true }).selectOption("10");
  await select(page, 1).check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await select(page, 11).check();
  await page.getByRole("link", { name: "#11 Task 11", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Unsaved hashtag draft");
  page.once("dialog", (prompt) => prompt.dismiss());
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add tags", exact: true });
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("Unsaved hashtag draft");
  page.once("dialog", (prompt) => prompt.accept());
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  await expect(dialog).toContainText("Add tags to 2 selected issues.");
  const input = dialog.getByRole("textbox", { name: "New tags", exact: true });
  const add = dialog.getByRole("button", { name: "Add tags", exact: true });
  await expect(input).toBeFocused();
  await expect(add).toBeDisabled();
  await input.fill("missing-hash");
  await expect(dialog.getByRole("alert")).toContainText("Start each tag with #");
  await expect(add).toBeDisabled();
  await input.fill("#" + "x".repeat(51));
  await expect(dialog.getByRole("alert")).toContainText("at most 50 characters");
  await expect(add).toBeDisabled();
  await input.fill("#triage #triage #日本語 #[needs review]");
  const existing = dialog.getByRole("checkbox", { name: "#existing", exact: true });
  await existing.check();
  await expect(dialog.getByRole("status")).toContainText("4 tags to add");
  await existing.uncheck();
  await expect(dialog.getByRole("status")).toContainText("3 tags to add");
  await existing.check();
  await dialog.screenshot({ path: "test-results/bulk-hashtags-desktop.png" });

  // A concurrent saved edit must not be overwritten by the stale list snapshot.
  const latestBody = issues[0].body + "\n\nLatest remote edit.";
  expect((await page.request.patch(`/api/issues/${issues[0].id}`, { headers, data: { body: latestBody } })).ok()).toBeTruthy();
  const endpoint = `/api/projects/${project.slug}/issues/labels`;
  await page.route(`**${endpoint}`, (route) => route.fulfill({ status: 500, json: { error: "Hashtags failed" } }));
  await add.click();
  await expect(dialog.getByRole("alert")).toContainText("Hashtags failed");
  await expect(input).toHaveValue("#triage #triage #日本語 #[needs review]");
  await expect(existing).toBeChecked();
  expect((await fetchIssue(page, issues[0].id)).body).toBe(latestBody);
  await page.unroute(`**${endpoint}`);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route(`**${endpoint}`, async (route) => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ issueIds: [issues[0].id, issues[10].id], labels: ["existing", "triage", "日本語", "needs review"] });
    await gate;
    await route.continue();
  });
  await add.click();
  await expect(dialog.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toBeHidden();
  expect(requests).toBe(1);
  await page.unroute(`**${endpoint}`);
  const first = await fetchIssue(page, issues[0].id);
  const last = await fetchIssue(page, issues[10].id);
  expect(first.body.startsWith(latestBody + "\n\n")).toBeTruthy();
  expect(last.body.startsWith(issues[10].body + "\n\n")).toBeTruthy();
  for (const issue of [first, last]) {
    expect(issue.labels).toEqual(["existing", "triage", "日本語", "needs review"]);
    expect(extractIssueLabels(issue.body)).toEqual(issue.labels);
    expect(issue.body.match(/#existing/g)).toHaveLength(1);
  }
  expect(await fetchIssue(page, issues[1].id)).toEqual(issues[1]);
  await expect(page.locator(".issue-row").filter({ hasText: "Task 11" })).toContainText("triage");
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New tags", exact: true }).fill("#triage");
  await add.click();
  await expect(dialog).toBeHidden();
  expect(await fetchIssue(page, issues[0].id)).toEqual(first);
  expect(await fetchIssue(page, issues[10].id)).toEqual(last);
  await page.reload();
  await page.getByRole("button", { name: "Tags filters", exact: true }).click();
  await page.getByLabel("Filter by tag", { exact: true }).selectOption("label:triage");
  await page.keyboard.press("Escape");
  await expect(page.locator(".issue-row")).toHaveCount(2);
});

test("mobile board and closed-list selection can add hashtags without changing membership or lifecycle", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { project, issues, headers } = await seed(page, baseURL!, 3);
  const boardEndpoint = `/api/projects/${project.slug}/board`;
  expect((await page.request.post(`${boardEndpoint}/issues`, { headers, data: { issueIds: issues.map((issue) => issue.id), lane: "todo" } })).ok()).toBeTruthy();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(3);
  await select(page, 1).check();
  await select(page, 2).check();
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add tags", exact: true });
  await dialog.getByRole("textbox", { name: "New tags", exact: true }).fill("#board-tag");
  await page.screenshot({ path: "test-results/bulk-hashtags-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await dialog.getByRole("button", { name: "Add tags", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".board-card").filter({ hasText: "Task 1" })).toContainText("board-tag");
  await expect(page.locator(".board-card").filter({ hasText: "Task 2" })).toContainText("board-tag");
  expect((await fetchIssue(page, issues[2].id)).labels).toEqual(["existing"]);
  expect((await (await page.request.get(boardEndpoint)).json()).board.cards).toHaveLength(3);

  expect((await page.request.patch(`/api/issues/${issues[0].id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  await page.goto(`/projects/${project.slug}?state=closed`);
  await select(page, 1).check();
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New tags", exact: true }).fill("#closed-tag");
  await dialog.getByRole("button", { name: "Add tags", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".issue-row")).toContainText("closed-tag");
  const closed = await fetchIssue(page, issues[0].id);
  expect(closed.state).toBe("closed");
  expect(closed.labels).toEqual(["existing", "board-tag", "closed-tag"]);
});
