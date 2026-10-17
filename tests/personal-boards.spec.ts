import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { openTableFilter } from "./filter-helpers";
import { mentionMarkdown } from "../shared/mentions";
const saved = (page: Page) =>
  expect(
    page.getByRole("status").filter({ hasText: "All changes saved" }),
  ).toBeVisible();
async function auth(page: Page, origin: string) {
  const { setupRequired } = await (
    await page.request.get("/api/auth/status")
  ).json();
  const response = await page.request.post(
    setupRequired ? "/api/auth/setup" : "/api/auth/login",
    {
      headers: { Origin: origin },
      data: {
        ...(setupRequired ? { name: "Alex Morgan" } : {}),
        email: "alex@example.test",
        password: "local-browser-test-password",
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()).user;
}
async function filter(page: Page, field: string, value: string) {
  await page
    .getByRole("region", { name: "Personal board filters" })
    .getByRole("button", { name: "Add filter", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit filter", exact: true });
  await editor.getByLabel("Field", { exact: true }).selectOption(field);
  await editor.getByLabel("Value", { exact: true }).selectOption(value);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await saved(page);
}
test("personal boards save filters, private lanes and placement across browsers; rename and delete", async ({
  page,
  browser,
  baseURL,
}) => {
  const user = await auth(page, baseURL!);
  const headers = { Origin: baseURL!, "X-Workspace-Slug": "default" };
  const name = `Focus ${randomUUID()}`;
  const { project } = await (
    await page.request.post("/api/projects", { headers, data: { name } })
  ).json();
  const created = await page.request.post(
    `/api/projects/${project.slug}/issues`,
    {
      headers,
      data: { body: `# Personal matching work\n\n${mentionMarkdown(user)}` },
    },
  );
  expect(created.ok()).toBeTruthy();
  const { issue } = await created.json();
  await page.request.post(`/api/projects/${project.slug}/issues`, {
    headers,
    data: { body: "Not tagged work" },
  });
  const before = await (
    await page.request.get(`/api/projects/${project.slug}/board`, { headers })
  ).json();
  await page.goto("/w/default/boards");
  await page
    .getByRole("button", { name: "Create personal board", exact: true })
    .click();
  await page.getByLabel("Board name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const url = page.url();
  const id = url.split("/").pop()!;
  await filter(page, "project", project.id);
  await filter(page, "tagged", user.id);
  await expect(page.locator(".personal-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await page.getByLabel("New lane name").fill("My priority");
  await page.getByRole("button", { name: "Add lane", exact: true }).click();
  await saved(page);
  await page
    .getByRole("button", { name: "Move My priority earlier", exact: true })
    .click();
  await saved(page);
  const laneInput = page.getByLabel("Name for My priority", { exact: true });
  await laneInput.fill("Today");
  await laneInput.press("Enter");
  await saved(page);
  await page
    .getByLabel(`Move issue ${issue.number} to lane`)
    .selectOption({ label: "Today" });
  await saved(page);
  await page
    .getByRole("button", { name: "Collapse Today", exact: true })
    .click();
  await saved(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Expand Today", exact: true }),
  ).toBeVisible();
  const state = await page.context().storageState();
  const context = await browser.newContext({ storageState: state });
  const fresh = await context.newPage();
  await fresh.goto(url);
  await expect(fresh.getByRole("heading", { name, exact: true })).toBeVisible();
  await fresh
    .getByRole("button", { name: "Expand Today", exact: true })
    .click();
  await saved(fresh);
  await expect(
    fresh
      .getByRole("region", { name: "Today lane", exact: true })
      .getByRole("link", { name: "Personal matching work" }),
  ).toBeVisible();
  expect(
    await (
      await page.request.get(`/api/projects/${project.slug}/board`, { headers })
    ).json(),
  ).toEqual(before);
  await fresh
    .getByRole("button", { name: "Rename board", exact: true })
    .click();
  await fresh.getByLabel("Board name", { exact: true }).fill(`${name} renamed`);
  await fresh.getByRole("button", { name: "Confirm rename" }).click();
  await saved(fresh);
  await fresh
    .getByRole("button", { name: "Delete board", exact: true })
    .click();
  await fresh.getByRole("button", { name: "Confirm delete" }).click();
  await expect(fresh).toHaveURL(/\/w\/default\/boards$/);
  expect(
    (await page.request.get(`/api/me/boards/${id}`, { headers })).status(),
  ).toBe(404);
  await context.close();
});

test("All issues imports composite project-lane filters and search losslessly", async ({
  page,
  baseURL,
}) => {
  await auth(page, baseURL!);
  const headers = { Origin: baseURL!, "X-Workspace-Slug": "default" };
  const name = `Import ${randomUUID()}`;
  const { project } = await (
    await page.request.post("/api/projects", { headers, data: { name } })
  ).json();
  const created = await page.request.post(
    `/api/projects/${project.slug}/issues`,
    {
      headers,
      data: { body: "Imported lane work" },
    },
  );
  expect(created.ok()).toBeTruthy();
  const { issue } = await created.json();
  const response = await page.request.put(
    `/api/projects/${project.slug}/board/issues`,
    { headers, data: { issueIds: [issue.id], lane: "todo" } },
  );
  expect(response.ok()).toBeTruthy();
  await page.goto("/w/default/issues");
  const editor = await openTableFilter(page, "lane");
  const lane = JSON.stringify([project.id, "todo"]);
  await editor
    .getByRole("combobox", { name: "Filter by board lane" })
    .selectOption(lane);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByPlaceholder("Search issues…").fill(`!${issue.number}`);
  await page.getByRole("link", { name: "Save as personal board" }).click();
  await page.getByLabel("Board name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await expect(page.locator(".personal-card")).toHaveCount(1);
  await expect(page.locator(".personal-card")).toContainText(
    "Imported lane work",
  );
  await expect(page.getByLabel("Search personal board")).toHaveValue(
    `!${issue.number}`,
  );
  const { board } = await (
    await page.request.get(`/api/me/boards/${page.url().split("/").pop()}`, {
      headers,
    })
  ).json();
  expect(
    board.filters.conditions.some(
      (condition: { field: string; value: string }) =>
        condition.field === "lane" && condition.value === lane,
    ),
  ).toBe(true);
});

test("mobile lane management persists, restores built-ins, and never overflows the viewport", async ({ page, baseURL }, testInfo) => {
  await auth(page, baseURL!);
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Mobile focus ${randomUUID()}` } })).json();
  await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Review the release checklist #release" } });
  const { board } = await (await page.request.post("/api/me/boards", { headers, data: { name: "My release focus", filters: { conjunction: "and", conditions: [{ id: "project", field: "project", operator: "is", value: project.id }] } } })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/default/boards/${board.id}`);
  await expect(page.locator(".personal-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
  const manager = page.getByRole("region", { name: "Manage personal lanes", exact: true });
  await manager.getByLabel("Name for Todo", { exact: true }).fill("Next up");
  await manager.getByLabel("Name for Todo", { exact: true }).press("Enter"); await saved(page);
  page.once("dialog", dialog => dialog.accept());
  await manager.getByRole("button", { name: "Remove Done lane", exact: true }).click(); await saved(page);
  await expect(page.getByRole("region", { name: "Done lane", exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "Restore Done lane", exact: true }).click(); await saved(page);
  await manager.locator(".personal-lane-setting").filter({ has: page.getByLabel("Name for In progress", { exact: true }) }).getByLabel("Hide", { exact: true }).check(); await saved(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
  const card = await page.locator(".personal-card").boundingBox();
  const laneBox = await page.getByRole("region", { name: "Next up lane", exact: true }).boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(laneBox!.x + laneBox!.width);
  await page.screenshot({ path: testInfo.outputPath("personal-board-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("personal-board-desktop.png"), fullPage: true });
  await page.reload();
  await expect(page.getByRole("region", { name: "Next up lane", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "In progress lane", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all lanes", exact: true }).click(); await saved(page);
  await expect(page.getByRole("region", { name: "In progress lane", exact: true })).toBeAttached();
});

test("conflicting tab saves expose reload rather than overwrite remote changes", async ({ page, baseURL }) => {
  await auth(page, baseURL!);
  const headers = { Origin: baseURL! };
  const { board } = await (await page.request.post("/api/me/boards", { headers, data: { name: `Conflict ${randomUUID()}` } })).json();
  await page.goto(`/w/default/boards/${board.id}`); await saved(page);
  expect((await page.request.patch(`/api/me/boards/${board.id}`, { headers, data: { revision: board.revision, name: "Saved in another tab" } })).ok()).toBeTruthy();
  await page.getByLabel("Search personal board").fill("unsaved search");
  await expect(page.getByRole("button", { name: "Retry saving", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed in another tab");
  const remote = (await (await page.request.get(`/api/me/boards/${board.id}`)).json()).board;
  expect(remote.name).toBe("Saved in another tab"); expect(remote.search).toBe("");
  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved in another tab", exact: true })).toBeVisible();
  await expect(page.getByLabel("Search personal board")).toHaveValue("");
});

test("rapid edits cannot be silently discarded by local navigation while a save is pending", async ({
  page,
  baseURL,
}) => {
  await auth(page, baseURL!);
  const headers = { Origin: baseURL!, "X-Workspace-Slug": "default" };
  const { board } = await (
    await page.request.post("/api/me/boards", {
      headers,
      data: { name: `Queue ${randomUUID()}` },
    })
  ).json();
  await page.goto(`/w/default/boards/${board.id}`);
  await saved(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/me/boards/${board.id}`, async (route) => {
    if (route.request().method() === "PATCH" && !intercepted) {
      intercepted = true;
      await gate;
    }
    await route.continue();
  });
  await page.getByLabel("Search personal board").fill("first");
  await expect.poll(() => intercepted).toBe(true);
  await page.getByLabel("Search personal board").fill("latest");
  let confirmationText = "";
  page.once("dialog", async (dialog) => {
    confirmationText = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "← Personal boards" }).click();
  expect(confirmationText).toContain("not saved");
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  release();
  await saved(page);
  await page.reload();
  await expect(page.getByLabel("Search personal board")).toHaveValue("latest");
});
