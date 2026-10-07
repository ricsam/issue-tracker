import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { Issue } from "../shared/types";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Selection ${randomUUID()}` } })).json();
  const issues: Issue[] = [];
  for (let n = 1; n <= 4; n++) {
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
const select = (page: Page, n: number) => page.getByRole("checkbox", { name: `Select issue #${n}`, exact: true });

test("board menu supports keyboard, range selection, bulk moves, drag and retryable remove", async ({ page, baseURL }) => {
  const { endpoint, issues } = await seed(page, baseURL!);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const trigger = page.getByRole("button", { name: "Board actions for issue #1", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Todo (current lane)" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "In progress", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await select(page, 1).check();
  await select(page, 3).click({ modifiers: ["Shift"] });
  for (const n of [1, 2, 3]) await expect(select(page, n)).toBeChecked();
  await expect(select(page, 4)).not.toBeChecked();
  await trigger.click();
  await expect(page.getByRole("menu")).toContainText("Applies to 3 selected issues");
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect(column(page, "In progress").locator(".board-card")).toHaveCount(3);
  await expect(page.locator(".board-outcome")).toHaveText("3 of 3 issues moved.");
  await expect(page.locator(".board-card.is-bulk-selected")).toHaveCount(0);
  await select(page, 1).check();
  await select(page, 2).check();
  await page.locator(".board-card").filter({ has: select(page, 1) }).dragTo(column(page, "Done"));
  await expect(column(page, "Done").locator(".board-card")).toHaveCount(2);
  await expect(column(page, "In progress").locator(".board-card")).toHaveCount(1);
  await select(page, 1).check();
  await select(page, 2).check();
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
  await expect(select(page, 2)).toBeChecked();
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
  await select(page, 1).check();
  await select(page, 2).check();
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("issue 4");
  await expect(page.getByRole("button", { name: "Tag selected issues" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("");
  await select(page, 1).check();
  await select(page, 2).check();
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
  await select(page, 1).check();
  await select(page, 2).check();
  await page.getByRole("link", { name: "#1 Selection issue 1", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
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
