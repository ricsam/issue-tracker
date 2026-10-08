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

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Shortcuts ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Existing issue\n\n#bug" } })).json();
  await page.goto(`/projects/${project.slug}`);
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeVisible();
  return { project, issue, headers };
}

for (const modifier of ["Control", "Meta"]) {
  test(`${modifier}+N opens a draft, ${modifier}+S creates and saves only the focused issue`, async ({ page, baseURL }) => {
    const { issue } = await seed(page, baseURL!);
    const createButton = page.getByRole("button", { name: "Create issue", exact: true });
    await expect(createButton).toHaveAttribute("title", /N; Alt\+N/);
    await expect(createButton).toHaveAttribute("aria-keyshortcuts", "Meta+N Control+N Alt+N");
    // Automation delivers reserved keys directly; real browsers may require Alt+N.
    await page.keyboard.press(`${modifier}+n`);
    const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
    const draft = dialog.getByRole("textbox", { name: "Issue", exact: true });
    await expect(draft).toBeFocused();
    await draft.fill("Shortcut creation");
    await draft.press("Alt+n");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(draft).toContainText("Shortcut creation");
    await draft.press(`${modifier}+s`);
    await expect(dialog.getByRole("status")).toContainText("Issue #2 created.");
    await expect(draft).toBeEmpty();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();

    await page.getByRole("link", { name: "#1 Existing issue", exact: true }).click();
    const sidebar = page.getByRole("complementary", { name: "Issue details", exact: true });
    const editor = sidebar.getByRole("textbox", { name: "Issue", exact: true });
    const save = sidebar.getByRole("button", { name: "Save changes", exact: true });
    await expect(save).toHaveAttribute("title", /Save issue \((Ctrl\+|⌘)S\)/);
    await expect(sidebar).not.toContainText("#hashtags outside code become labels automatically.");
    await editor.fill("Saved from rich mode");
    let writes = 0;
    page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith(`/api/issues/${issue.id}`)) writes++; });
    await editor.press(`${modifier}+s`);
    await expect(sidebar.getByText("Changes saved", { exact: true })).toBeVisible();
    expect(writes).toBe(1);
    expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.body).toContain("Saved from rich mode");

    await sidebar.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
    const source = sidebar.locator(".detail-form").getByLabel("Markdown source");
    await source.fill("Saved from source mode #new-tag");
    await source.press(`${modifier}+s`);
    await expect(sidebar.getByText("Changes saved", { exact: true })).toBeVisible();
    expect(writes).toBe(2);
    await source.fill("Draft must stay unsaved under a modal");
    await source.press("Alt+n");
    await expect(dialog).toBeVisible();
    await draft.fill("Another issue");
    await draft.press(`${modifier}+s`);
    await expect(dialog.getByRole("status")).toContainText("Issue #3 created.");
    expect(writes).toBe(2);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(source).toHaveValue("Draft must stay unsaved under a modal");

    // A selected list row is also issue focus, even though the sidebar isn't focused.
    await page.locator(`a[data-issue-id="${issue.id}"]`).focus();
    await page.keyboard.press(`${modifier}+s`);
    await expect(sidebar.getByText("Changes saved", { exact: true })).toBeVisible();
    expect(writes).toBe(3);
  });
}

test("full-page shortcuts, project tag catalog, busy protection and archived guards", async ({ page, baseURL }) => {
  const { project, issue, headers } = await seed(page, baseURL!);
  await page.goto(`/issues/${issue.id}`);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Full page #bu");
  await expect(page.getByRole("option", { name: "#bug", exact: true })).toBeVisible();
  await editor.press("Tab");
  await expect(editor).toContainText("#bug");
  await editor.press("Control+s");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await editor.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await editor.fill("Busy save");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route(`**/api/issues/${issue.id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++; await gate; await route.continue();
  });
  await editor.press("Control+s");
  await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+s");
  release();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.unroute(`**/api/issues/${issue.id}`);
  await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } });
  await page.reload();
  await expect(page.getByText(/This issue belongs to an archived project/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await page.keyboard.press("Alt+n");
  await expect(dialog).toHaveCount(0);
});
