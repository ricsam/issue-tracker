import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

let adminSession: Awaited<ReturnType<APIRequestContext["storageState"]>>;
const password = "local-browser-test-password";
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password },
  })).ok()).toBeTruthy();
  adminSession = await request.storageState();
});
const accessDialog = (page: Page) => page.getByRole("dialog", { name: "Manage project access", exact: true });

for (const width of [1440, 390]) test(`private creation, sharing, collaboration, revocation and archived ownership transfer at ${width}px`, async ({ browser, baseURL }) => {
  const headers = { Origin: baseURL! };
  const viewport = { width, height: 900 };
  const admin = await browser.newContext({ baseURL, viewport, storageState: adminSession });
  const contexts = [admin];
  try {
    async function member(label: string) {
      const email = `${label}-${randomUUID()}@example.test`;
      const name = `${label} ${randomUUID().slice(0, 8)}`;
      const response = await admin.request.post("/api/admin/users", { headers, data: { name, email, password } });
      expect(response.ok()).toBeTruthy();
      const context = await browser.newContext({ baseURL, viewport });
      contexts.push(context);
      expect((await context.request.post("/api/auth/login", { headers, data: { email, password } })).ok()).toBeTruthy();
      const { user } = await (await context.request.get("/api/auth/status")).json();
      return { context, page: await context.newPage(), user };
    }
    const owner = await member("Owner");
    const shared = await member("Shared");
    const outsider = await member("Outsider");
    const adminPage = await admin.newPage();
    const name = `Scoped ${randomUUID()}`;
    await owner.page.goto("/projects");
    await owner.page.locator(".page-heading").getByRole("button", { name: "Create project", exact: true }).click();
    const create = owner.page.getByRole("dialog", { name: "Create project", exact: true });
    await create.getByLabel("Project name").fill(name);
    await create.getByLabel("Visibility").selectOption("private");
    await create.getByRole("checkbox", { name: `${shared.user.name} (${shared.user.email})`, exact: true }).check();
    await create.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(owner.page).toHaveURL(/\/projects\/[^/?]+$/);
    await expect(owner.page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
    const path = new URL(owner.page.url()).pathname;
    await expect(owner.page.getByLabel("Project access", { exact: true })).toContainText("Private");
    await expect(owner.page.getByLabel("Project access", { exact: true })).toContainText(`Owner: ${owner.user.name}`);
    for (const page of [shared.page, adminPage]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect(adminPage.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
    await expect(shared.page.getByRole("button", { name: "Manage access", exact: true })).toHaveCount(0);
    await shared.page.getByRole("button", { name: "Edit project", exact: true }).click();
    const edit = shared.page.getByRole("dialog", { name: "Edit project", exact: true });
    await edit.getByLabel("Description").fill("Shared users can collaborate");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await outsider.page.goto("/projects");
    await expect(outsider.page.getByRole("heading", { name, exact: true })).toHaveCount(0);
    await expect(outsider.page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name, exact: true })).toHaveCount(0);
    await outsider.page.goto(path);
    await expect(outsider.page.getByRole("alert")).toBeVisible();
    await expect(outsider.page.getByRole("heading", { name, exact: true })).toHaveCount(0);

    // Public collaborators gain access, but never gain access-management rights.
    await owner.page.getByRole("button", { name: "Manage access", exact: true }).click();
    await accessDialog(owner.page).getByLabel("Visibility").selectOption("public");
    await accessDialog(owner.page).getByRole("button", { name: "Save access" }).click();
    await expect(accessDialog(owner.page)).toBeHidden();
    await outsider.page.reload();
    await expect(outsider.page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(outsider.page.getByRole("button", { name: "Edit project", exact: true })).toBeVisible();
    await expect(outsider.page.getByRole("button", { name: "Manage access", exact: true })).toHaveCount(0);

    // Revoke both explicit sharing and workspace-wide access.
    await owner.page.getByRole("button", { name: "Manage access", exact: true }).click();
    await accessDialog(owner.page).getByLabel("Visibility").selectOption("private");
    await accessDialog(owner.page).getByRole("checkbox", { name: `${shared.user.name} (${shared.user.email})`, exact: true }).uncheck();
    await accessDialog(owner.page).getByRole("button", { name: "Save access" }).click();
    await expect(accessDialog(owner.page)).toBeHidden();
    for (const page of [shared.page, outsider.page]) {
      await page.reload();
      await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
      await expect(page.getByRole("alert")).toBeVisible();
      await page.goto("/projects");
      await expect(page.locator(".project-card").filter({ hasText: name })).toHaveCount(0);
    }
    expect((await owner.context.request.patch(`/api${path}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
    await owner.page.reload();
    await expect(owner.page.getByText("This project is archived.", { exact: true })).toBeVisible();
    await expect(owner.page.getByRole("button", { name: "Edit project", exact: true })).toHaveCount(0);
    await owner.page.getByRole("button", { name: "Manage access", exact: true }).click();
    await accessDialog(owner.page).getByLabel("Project owner").selectOption(shared.user.id);
    owner.page.once("dialog", (dialog) => dialog.accept());
    await accessDialog(owner.page).getByRole("button", { name: "Save access" }).click();
    await expect(owner.page).toHaveURL("/projects");
    await expect(owner.page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name, exact: true })).toHaveCount(0);
    await owner.page.goto("/projects?view=archived");
    await expect(owner.page.locator(".project-card").filter({ hasText: name })).toHaveCount(0);
    await shared.page.goto(path);
    await expect(shared.page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
    await adminPage.reload();
    await adminPage.getByRole("button", { name: "Manage access", exact: true }).click();
    await expect(accessDialog(adminPage).getByLabel("Project owner")).toHaveValue(shared.user.id);
    await accessDialog(adminPage).getByLabel("Visibility").selectOption("public");
    await accessDialog(adminPage).getByRole("button", { name: "Save access" }).click();
    await expect(accessDialog(adminPage)).toBeHidden();
    await outsider.page.goto(path);
    await expect(outsider.page.getByText("This project is archived.", { exact: true })).toBeVisible();
    await expect(outsider.page.getByRole("button", { name: "Manage access", exact: true })).toHaveCount(0);
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});
