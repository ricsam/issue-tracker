import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });
const modal = (page: Page) => page.getByRole("dialog", { name: "Edit project", exact: true });
async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const response = await page.request.post("/api/projects", { headers, data: { name: `Edit ${randomUUID()}`, description: "Original description" } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  return { project, headers, path: `/projects/${project.slug}` };
}

for (const width of [1440, 390]) {
  test(`edit project from list and board preserves URL and updates navigation and cards at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const { project, path } = await seed(page, baseURL!);
    await page.goto(path);
    await page.getByRole("button", { name: "Edit project", exact: true }).click();
    await expect(modal(page).getByRole("textbox", { name: "Project name" })).toHaveValue(project.name);
    await expect(modal(page).getByRole("textbox", { name: "Description" })).toHaveValue("Original description");
    await expect(modal(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
    const name = `Renamed ${randomUUID()}`;
    await modal(page).getByRole("textbox", { name: "Project name" }).fill(name);
    await modal(page).getByRole("textbox", { name: "Description" }).fill("Updated purpose and scope");
    await page.screenshot({ path: `test-results/edit-project-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await modal(page).getByRole("button", { name: "Save changes" }).click();
    await expect(modal(page)).toBeHidden();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByText("Updated purpose and scope", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(path);
    await expect(page.getByText("Project updated", { exact: true })).toBeVisible();
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    const nav = page.getByRole("navigation", { name: "Workspace", exact: true });
    await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("href", path);
    await nav.getByRole("link", { name: "All projects", exact: true }).click();
    const card = page.locator(".project-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card).toContainText("Updated purpose and scope");
    await card.click();
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "Edit project", exact: true }).click();
    await modal(page).getByRole("textbox", { name: "Description" }).fill("");
    await modal(page).getByRole("button", { name: "Save changes" }).click();
    await expect(modal(page)).toBeHidden();
    await expect(page).toHaveURL(`${path}/board`);
    await expect(page.getByText("Every step forward starts here.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api${path}`)).json()).project).toMatchObject({ id: project.id, slug: project.slug, name, description: "" });
  });
}

test("project edits retain failed drafts, prevent blank names/duplicate saves and cancel without changing the project", async ({ page, baseURL }) => {
  const { project, path } = await seed(page, baseURL!);
  await page.goto(path);
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  const name = modal(page).getByRole("textbox", { name: "Project name" });
  await name.fill("   ");
  await expect(modal(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
  await name.fill("Unsaved project name");
  page.once("dialog", (prompt) => prompt.dismiss());
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(name).toHaveValue("Unsaved project name");
  page.once("dialog", (prompt) => prompt.accept());
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await expect(name).toHaveValue(project.name);
  await name.fill("Retry name");
  await page.route(`**/api${path}`, (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: "Edit failed" } }) : route.continue());
  await modal(page).getByRole("button", { name: "Save changes" }).click();
  await expect(modal(page).getByRole("alert")).toContainText("Edit failed");
  await expect(name).toHaveValue("Retry name");
  await page.unroute(`**/api${path}`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  await page.route(`**/api${path}`, async (route) => { if (route.request().method() === "PATCH") { writes++; await gate; } await route.continue(); });
  // The successful PATCH is enough to update the workspace, even if a later GET would fail.
  await page.route("**/api/projects", (route) => route.fulfill({ status: 500, json: { error: "Refresh unavailable" } }));
  try {
    await modal(page).getByRole("button", { name: "Save changes" }).click();
    await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(name).toBeDisabled();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await modal(page).getByRole("button", { name: "Close dialog" }).click();
    await expect(modal(page)).toBeVisible();
    expect(writes).toBe(1);
  } finally { release(); }
  await expect(modal(page)).toBeHidden();
  await expect(page.getByRole("heading", { name: "Retry name", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "Retry name", exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("editing project keeps sidebar issue drafts and archived projects require restore", async ({ page, baseURL }) => {
  const { project, path, headers } = await seed(page, baseURL!);
  const { issue } = await (await page.request.post(`/api${path}/issues`, { headers, data: { body: "Persisted issue" } })).json();
  await page.goto(path);
  await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  const editor = page.getByRole("complementary", { name: "Issue details", exact: true }).getByRole("textbox", { name: "Issue", exact: true });
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await editor.fill("Unsaved issue stays");
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await modal(page).getByRole("textbox", { name: "Project name" }).fill("Changed with draft");
  await modal(page).getByRole("button", { name: "Save changes" }).click();
  await expect(modal(page)).toBeHidden();
  await expect(editor).toContainText("Unsaved issue stays");
  expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.body).toBe("Persisted issue");
  // Archive from another tab while the edit form is open: server rejects the stale edit.
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await modal(page).getByRole("textbox", { name: "Description" }).fill("Must not edit archived");
  await page.request.patch(`/api${path}`, { headers, data: { archived: true } });
  await modal(page).getByRole("button", { name: "Save changes" }).click();
  await expect(modal(page).getByRole("alert")).toContainText("Project is archived");
  await page.goto(path);
  await expect(page.getByText("This project is archived.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit project", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit project", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api${path}`)).json()).project).toMatchObject({ id: project.id, description: "Original description" });
});
