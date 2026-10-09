import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const auth = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(auth.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

const body = "# Preview first\n\nRead **formatted content** without editing.\n\n| Feature | State |\n| --- | --- |\n| Tables | Preserved |\n\n- [x] Ready to read";
const detail = (page: Page) => page.locator(".detail-form");
const mode = (editor: Locator, name: string) => editor.getByRole("button", { name, exact: true });

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const response = await page.request.post("/api/projects", {
    headers, data: { name: `Preview ${randomUUID()}` },
  });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  const issueIds: string[] = [];
  for (const content of [body, "# Another issue\n\nAnother body"]) {
    const created = await page.request.post(`/api/projects/${project.slug}/issues`, {
      headers, data: { body: content },
    });
    expect(created.ok()).toBeTruthy();
    issueIds.push((await created.json()).issue.id);
  }
  return { project, issueIds, headers };
}

async function expectPreview(editor: Locator, title: string) {
  await expect(mode(editor, "Preview")).toHaveAttribute("aria-pressed", "true");
  await expect(mode(editor, "Write")).toHaveAttribute("aria-pressed", "false");
  await expect(mode(editor, "Markdown")).toHaveAttribute("aria-pressed", "false");
  await expect(editor.locator(".editor-preview").getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(editor.getByRole("textbox")).toHaveCount(0);
  await expect(editor.getByRole("group", { name: "Text formatting" })).toHaveCount(0);
  await expect(mode(editor, "Attach files")).toBeDisabled();
}

for (const width of [1440, 390]) {
  test(`full-page issues open in Preview and preserve Markdown when read and saved at ${width}px`, async ({ page, baseURL }) => {
    const { issueIds } = await seed(page, baseURL!);
    const endpoint = `/api/issues/${issueIds[0]}`;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/issues/${issueIds[0]}`);
    const editor = detail(page);
    await expectPreview(editor, "Preview first");
    await expect(editor.getByRole("table")).toContainText("Preserved");
    await expect(editor.locator(".editor-preview strong")).toHaveText("formatted content");
    await expect(editor.getByRole("checkbox")).toBeChecked();
    await page.screenshot({ path: `test-results/issue-preview-${width}.png` });

    // Merely viewing an issue must not normalize its source through rich editing.
    await mode(editor, "Save changes").click();
    await expect(editor.getByRole("status")).toHaveText("Changes saved");
    expect((await (await page.request.get(endpoint)).json()).issue.body).toBe(body);
    await expectPreview(editor, "Preview first");
    await mode(editor, "Markdown").click();
    const source = editor.getByRole("textbox", { name: "Markdown source" });
    await expect(source).toHaveValue(body);
    const edited = body.replace("Preserved", "Updated in Markdown");
    await source.fill(edited);
    await mode(editor, "Preview").click();
    await expect(editor.getByRole("table")).toContainText("Updated in Markdown");
    await mode(editor, "Save changes").click();
    await expect(editor.getByRole("status")).toHaveText("Changes saved");
    expect((await (await page.request.get(endpoint)).json()).issue.body).toBe(edited);
    await page.reload();
    await expectPreview(detail(page), "Preview first");
    await expect(detail(page).getByRole("table")).toContainText("Updated in Markdown");
  });
}

for (const board of [false, true]) {
  test(`${board ? "board" : "list"} sidebar resets to Preview for each newly opened issue`, async ({ page, baseURL }) => {
    const { project, issueIds, headers } = await seed(page, baseURL!);
    if (board) {
      const placed = await page.request.post(`/api/projects/${project.slug}/board/issues`, {
        headers, data: { issueIds, lane: "todo" },
      });
      expect(placed.ok()).toBeTruthy();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const path = `/projects/${project.slug}${board ? "/board" : ""}`;
    await page.goto(path);
    const link = (index: number) => page.locator(`.project-issues-content .issue-link[href="/issues/${issueIds[index]}"]`);
    const prompts: string[] = [];
    page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
    await link(0).click();
    await expectPreview(detail(page), "Preview first");
    // Choosing an editing tab without changing content is not a dirty draft.
    await mode(detail(page), "Markdown").click();
    await expect(detail(page).getByRole("textbox", { name: "Markdown source" })).toHaveValue(body);
    await link(1).click();
    await expectPreview(detail(page), "Another issue");
    await mode(detail(page), "Write").click();
    await expect(detail(page).getByRole("textbox", { name: "Issue", exact: true })).toContainText("Another body");
    await link(0).click();
    await expectPreview(detail(page), "Preview first");
    await page.getByRole("button", { name: "Close issue details" }).click();
    await link(0).click();
    await expectPreview(detail(page), "Preview first");
    await expect(page).toHaveURL(path);
    expect(prompts).toEqual([]);
  });
}

test("Write still edits existing issues while new issues and comments start in Write", async ({ page, baseURL }) => {
  const { issueIds } = await seed(page, baseURL!);
  await page.goto(`/issues/${issueIds[1]}`);
  const editor = detail(page);
  await expectPreview(editor, "Another issue");
  await mode(editor, "Write").click();
  const input = editor.getByRole("textbox", { name: "Issue", exact: true });
  await expect(input).toContainText("Another body");
  await input.fill("Edited in Write");
  await mode(editor, "Markdown").click();
  await expect(editor.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# Edited in Write");
  await mode(editor, "Write").click();
  await expect(input).toHaveText("Edited in Write");
  await mode(editor, "Save changes").click();
  await expect(editor.getByRole("status")).toHaveText("Changes saved");
  // Saving does not kick the user out of their chosen editing mode.
  await expect(mode(editor, "Write")).toHaveAttribute("aria-pressed", "true");
  await mode(editor, "Preview").click();
  await expect(editor.locator(".editor-preview")).toHaveText("Edited in Write");
  expect((await (await page.request.get(`/api/issues/${issueIds[1]}`)).json()).issue.body).toBe("# Edited in Write");

  const comments = page.locator(".comments");
  await expect(mode(comments, "Write")).toHaveAttribute("aria-pressed", "true");
  await expect(comments.getByRole("textbox")).toBeVisible();
  await mode(editor, "Create issue").click();
  const dialog = page.getByRole("dialog");
  await expect(mode(dialog, "Write")).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("textbox", { name: "Issue", exact: true })).toBeFocused();
});
