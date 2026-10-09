import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { Issue } from "../shared/types";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Keyboard ${randomUUID()}` } })).json();
  const issues: Issue[] = [];
  for (let n = 0; n < 8; n++) {
    const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Keyboard issue ${n} ${n % 2 === 0 ? "#even" : "#odd"}` } })).json();
    issues.push(issue);
  }
  const endpoint = `/api/projects/${project.slug}/board`;
  for (const [lane, group] of [["todo", issues.slice(0, 4)], ["in_progress", issues.slice(4, 6)], ["done", issues.slice(6, 7)]] as const) {
    expect((await page.request.post(`${endpoint}/issues`, { headers, data: { lane, issueIds: group.map((i) => i.id) } })).ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}/board`);
  await expect(page.locator(".board-card")).toHaveCount(7);
  return { project, issues, endpoint, headers };
}
const cardLink = (page: Page, issue: Issue) => page.locator(`.board-card a[data-issue-id="${issue.id}"]`);
const selected = (page: Page) => page.locator(".board-card.is-bulk-selected");
const checkbox = (page: Page, issue: Issue) => page.getByRole("checkbox", { name: `Select issue !${issue.number}`, exact: true });
const laneCheckbox = (page: Page, lane: string) => page.getByRole("checkbox", { name: `Select all visible issues in ${lane}`, exact: true });

test("board keyboard ranges extend, shrink, cross lanes, and use Cmd/Ctrl to select to lane edges", async ({ page, baseURL }) => {
  const { issues } = await seed(page, baseURL!);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await checkbox(page, issues[1]).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(2);
  await expect(cardLink(page, issues[2])).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(3);
  await page.keyboard.press("Shift+ArrowUp");
  await expect(selected(page)).toHaveCount(2);
  await expect(checkbox(page, issues[3])).not.toBeChecked();
  await page.keyboard.press("Meta+Shift+ArrowUp");
  await expect(selected(page)).toHaveCount(2);
  await expect(cardLink(page, issues[0])).toBeFocused();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(3);
  await expect(cardLink(page, issues[3])).toBeFocused();
  await expect(checkbox(page, issues[0])).not.toBeChecked();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(cardLink(page, issues[3])).toBeFocused();
  await expect(selected(page)).toHaveCount(3);
  await expect(page.getByRole("complementary", { name: "Issue details" })).toHaveCount(0);

  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await cardLink(page, issues[0]).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(selected(page)).toHaveCount(2);
  await expect(checkbox(page, issues[0])).toBeChecked();
  await expect(checkbox(page, issues[4])).toBeChecked();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(4);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(selected(page)).toHaveCount(2);
  await expect(checkbox(page, issues[4])).not.toBeChecked();
  // Plain arrows open details without changing the bulk selection; Shift stays selection-only.
  const preview = page.getByRole("complementary", { name: "Issue details" }).locator(".detail-form .editor-preview");
  await page.keyboard.press("ArrowRight");
  await expect(cardLink(page, issues[5])).toBeFocused();
  await expect(preview).toContainText(issues[5].title);
  await expect(selected(page)).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(cardLink(page, issues[6])).toBeFocused();
  await expect(preview).toContainText(issues[6].title);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(selected(page)).toHaveCount(4);
  await expect(preview).toContainText(issues[6].title);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(selected(page)).toHaveCount(3);
  // A successful no-op lane move still clears the selection/range. Extending
  // afterwards must not restore the old range's additive base.
  await page.getByRole("button", { name: `Board actions for issue !${issues[6].number}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(selected(page)).toHaveCount(0);
  await cardLink(page, issues[6]).focus();
  await page.keyboard.press("Shift+ArrowUp");
  await expect(selected(page)).toHaveCount(1);
  await expect(checkbox(page, issues[0])).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("plain board arrows open adjacent sidebar issues, respect boundaries/search, and leave editing controls alone", async ({ page, baseURL }) => {
  const { project, issues, endpoint, headers } = await seed(page, baseURL!);
  const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
  const preview = sidebar.locator(".detail-form .editor-preview");
  await cardLink(page, issues[0]).click();
  await expect(preview).toContainText(issues[0].title);
  await expect(cardLink(page, issues[0])).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(preview).toContainText(issues[0].title);
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText(issues[1].title);
  await expect(cardLink(page, issues[1])).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText(issues[2].title);
  await page.keyboard.press("ArrowUp");
  await expect(preview).toContainText(issues[1].title);
  await expect(page).toHaveURL(`/projects/${project.slug}/board`);
  await expect(selected(page)).toHaveCount(0);

  // Search and editors must not switch issues or turn cursor movement into navigation.
  const search = page.getByRole("textbox", { name: "Search issues", exact: true });
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  await expect(preview).toContainText(issues[1].title);
  await sidebar.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  const editor = sidebar.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Keep this board draft");
  await editor.press("ArrowDown");
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("Keep this board draft");
  await cardLink(page, issues[1]).focus();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("ArrowDown");
  await expect(cardLink(page, issues[1])).toBeFocused();
  await expect(editor).toContainText("Keep this board draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText(issues[2].title);
  await expect(cardLink(page, issues[2])).toBeFocused();
  const comment = sidebar.getByRole("textbox", { name: "Share an update or ask a question…", exact: true });
  await comment.fill("Keep this unsent comment");
  await cardLink(page, issues[2]).focus();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("ArrowUp");
  await expect(comment).toContainText("Keep this unsent comment");
  await expect(cardLink(page, issues[2])).toBeFocused();
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("ArrowUp");
  await expect(preview).toContainText(issues[1].title);

  await search.fill("even");
  await cardLink(page, issues[0]).click();
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText(issues[2].title);
  await expect(cardLink(page, issues[2])).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cardLink(page, issues[2])).toBeFocused();
  await expect(preview).toContainText(issues[2].title);
  // Closing restores the card focus; a checkbox can start sidebar navigation too.
  await sidebar.getByRole("button", { name: "Close issue details", exact: true }).click();
  await expect(cardLink(page, issues[2])).toBeFocused();
  await checkbox(page, issues[0]).focus();
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText(issues[2].title);
  await expect(selected(page)).toHaveCount(0);

  // Hidden lanes are skipped and archived issues remain navigable for reading.
  expect((await page.request.patch(endpoint, { headers, data: { lanes: ["todo", "done"] } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.reload();
  await cardLink(page, issues[0]).click();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar.getByRole("article", { name: "Issue", exact: true })).toContainText(issues[6].title);
  await expect(cardLink(page, issues[6])).toBeFocused();
});

test("board arrows use the existing full-page detail fallback on narrow screens", async ({ page, baseURL }) => {
  const { issues } = await seed(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await cardLink(page, issues[0]).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(`/issues/${issues[1].id}`);
  await expect(page.locator(".detail-form .editor-preview")).toContainText(issues[1].title);
});

test("lane selection is tri-state, additive, searchable and read-only safe", async ({ page, baseURL }) => {
  const { project, issues, headers } = await seed(page, baseURL!);
  const todo = laneCheckbox(page, "Todo");
  const progress = laneCheckbox(page, "In progress");
  await checkbox(page, issues[0]).check();
  await expect(todo).toBeChecked({ indeterminate: true });
  await todo.click();
  await expect(todo).toBeChecked();
  await expect(selected(page)).toHaveCount(4);
  await progress.check();
  await expect(selected(page)).toHaveCount(6);
  await todo.uncheck();
  await expect(selected(page)).toHaveCount(2);
  await expect(progress).toBeChecked();
  await page.getByRole("textbox", { name: "Search issues" }).fill("even");
  await expect(selected(page)).toHaveCount(0);
  await todo.check();
  await expect(selected(page)).toHaveCount(2);
  await cardLink(page, issues[0]).focus();
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await expect(cardLink(page, issues[2])).toBeFocused();
  await expect(selected(page)).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search issues" }).fill("no match");
  await expect(todo).toBeDisabled();
  await expect(selected(page)).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search issues" }).fill("");
  // A fresh range must not resurrect filtered-away cards or the previous anchor.
  await cardLink(page, issues[2]).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(2);
  await expect(checkbox(page, issues[0])).not.toBeChecked();
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.reload();
  await expect(todo).toBeDisabled();
  await cardLink(page, issues[0]).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(0);
});

test("board counts include closed and hidden issues, stay stable under search, and update after membership changes", async ({ page, baseURL }) => {
  const { project, issues, endpoint, headers } = await seed(page, baseURL!);
  const summary = page.locator(".board-summary");
  await expect(summary).toHaveText("7 of 8 issues assigned to board · 1 unassigned · 3 lanes");
  expect((await page.request.patch(`/api/issues/${issues[7].id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/issues/${issues[0].id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
  expect((await page.request.patch(endpoint, { headers, data: { lanes: ["todo", "done"] } })).ok()).toBeTruthy();
  await page.reload();
  await expect(summary).toHaveText("7 of 8 issues assigned to board · 1 unassigned · 2 lanes · 2 issues in hidden lanes");
  await page.getByRole("textbox", { name: "Search issues" }).fill("no match");
  await expect(summary).toHaveText("7 of 8 issues assigned to board · 1 unassigned · 2 lanes · 2 issues in hidden lanes");
  await page.getByRole("textbox", { name: "Search issues" }).fill("");
  await page.getByRole("button", { name: `Board actions for issue !${issues[0].number}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from board", exact: true }).click();
  await expect(summary).toHaveText("6 of 8 issues assigned to board · 2 unassigned · 2 lanes · 2 issues in hidden lanes");
  // Creation updates totals without adding the issue to the board.
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create issue" });
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("New unassigned issue");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(dialog.getByText(/Issue !\d+ created/)).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(summary).toHaveText("6 of 9 issues assigned to board · 3 unassigned · 2 lanes · 2 issues in hidden lanes");
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add issues to board" });
  await add.getByRole("checkbox", { name: /New unassigned issue/ }).check();
  await add.getByRole("button", { name: "Add to board", exact: true }).click();
  await expect(summary).toHaveText("7 of 9 issues assigned to board · 2 unassigned · 2 lanes · 2 issues in hidden lanes");
  expect((await page.request.get(`/api/projects/${project.slug}/issues`)).ok()).toBeTruthy();
});
