import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(response.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

for (const failure of [false, true]) {
  test(`remembered lane cannot silently create off-board during ${failure ? "failed" : "delayed"} validation`, async ({ page, baseURL }) => {
    const headers = { Origin: baseURL! };
    const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Validate lane ${randomUUID()}` } })).json();
    const endpoint = `/api/projects/${project.slug}/board`;
    await page.goto("/projects");
    const open = page.getByRole("button", { name: "Create issue (Alt+N)", exact: true });
    const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
    await open.click();
    await dialog.getByRole("combobox", { name: "Project", exact: true }).selectOption(project.id);
    await dialog.getByRole("combobox", { name: "Board lane", exact: true }).selectOption("done");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**${endpoint}`, async (route) => {
      if (failure) await route.fulfill({ status: 500, json: { error: "Board unavailable" } });
      else { await held; await route.continue(); }
    });
    let posts = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/issues")) posts++; });
    try {
      await open.click();
      const editor = dialog.getByRole("textbox", { name: "Issue", exact: true });
      await editor.fill("Keep my chosen lane");
      await expect(dialog.getByRole("button", { name: "Create issue", exact: true })).toBeDisabled();
      await editor.press("Control+Enter");
      await editor.press("Meta+Enter");
      await editor.press("Control+s");
      expect(posts).toBe(0);
      if (failure) {
        await expect(dialog.getByRole("alert")).toContainText("Board unavailable");
        await dialog.getByRole("button", { name: "Create without board placement" }).click();
      } else release();
      await expect(dialog.getByRole("button", { name: "Create issue", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
      await expect(editor).toBeEmpty();
      expect(posts).toBe(1);
    } finally { release(); await page.unroute(`**${endpoint}`); }
    const { board } = await (await page.request.get(endpoint)).json();
    expect(board.cards.map((card: { lane: string }) => card.lane)).toEqual(failure ? [] : ["done"]);
  });
}

test("post-Done toast protects drafts edited after the dialog closes and clears on navigation", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { issue } = await (await page.request.post("/api/issues", { headers, data: { body: "Original issue" } })).json();
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("New toast destination");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "View issue" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const toast = page.locator(".snackbar");
  const form = page.locator(".detail-form");
  await form.getByRole("button", { name: "Markdown", exact: true }).click();
  await form.getByLabel("Markdown source").fill("Draft edited after Done");
  page.once("dialog", (confirm) => confirm.dismiss());
  await toast.getByRole("link", { name: "View issue" }).click();
  await expect(page).toHaveURL(`/issues/${issue.id}`);
  await expect(form.getByLabel("Markdown source")).toHaveValue("Draft edited after Done");
  await page.getByRole("link", { name: "All projects", exact: true }).click();
  await expect(toast.getByRole("link", { name: "View issue" })).toHaveCount(0);
  await page.goBack();
  await expect(toast.getByRole("link", { name: "View issue" })).toHaveCount(0);
});

for (const width of [1440, 390, 320]) {
  test(`creation toast floats without shifting the editor at ${width}px`, async ({ page, baseURL }, testInfo) => {
    const headers = { Origin: baseURL! };
    const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Toast geometry ${randomUUID()}` } })).json();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.goto(`/projects/${project.slug}`);
    await page.getByRole("button", { name: "Create issue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
    const editor = dialog.getByRole("textbox", { name: "Issue", exact: true });
    await editor.fill("Geometry issue");
    const before = await dialog.locator(".rich-editor").boundingBox();
    await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
    const view = dialog.getByRole("link", { name: "View issue" });
    await expect(view).toBeVisible();
    const after = await dialog.locator(".rich-editor").boundingBox();
    expect(after?.y).toBeCloseTo(before!.y, 0);
    expect(after?.height).toBeCloseTo(before!.height, 0);
    await view.focus();
    await expect(view).toBeFocused();
    await expect(view).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Copy issue body" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`creation-toast-${width}.png`) });
  });
}
