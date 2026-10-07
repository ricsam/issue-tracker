import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

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

for (const mobile of [false, true]) test(`explicit mentions survive creation, source and preview${mobile ? " on mobile" : ""}`, async ({ page, baseURL }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.request.post("/api/projects", { headers: { Origin: baseURL! }, data: { name: `Mentions ${randomUUID()}` } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const editor = dialog.getByRole("textbox", { name: "Issue", exact: true });
  await editor.fill("Mention regression\n\nHello @alex");
  const options = dialog.getByRole("listbox", { name: "Mention suggestions" });
  await expect(options).toBeVisible();
  await page.screenshot({ path: `test-results/mention-suggestions-${mobile ? "mobile" : "desktop"}.png` });
  await editor.press("ArrowDown");
  await editor.press("ArrowUp");
  await editor.press("Enter");
  await expect(options).toBeHidden();
  await expect(editor.locator('[data-mention-user-id]')).toHaveCount(1);
  await expect(editor.locator('a')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = dialog.getByRole("textbox", { name: "Markdown source" });
  const markdown = await source.inputValue();
  expect(markdown).toMatch(/\[@[^\]]+\]\(mention:[0-9a-f-]+\)/);
  const id = /mention:([0-9a-f-]+)/.exec(markdown)![1];
  await source.fill(markdown + "\n\n@alex@example.test");
  await expect(options).toBeHidden();
  await source.fill(markdown + "\n\n`@alex");
  await expect(options).toBeHidden();
  await source.fill(markdown + "\n\n@not-a-real-teammate");
  await expect(dialog.getByText("No matching teammates")).toBeVisible();
  await source.press("Escape");
  await expect(options).toBeHidden();
  await expect(dialog).toBeVisible();
  await source.fill(markdown + "\n\n@alex");
  await expect(options).toBeVisible();
  const box = await options.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await options.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.locator(".editor-preview .mention-chip")).toHaveCount(2);
  await page.screenshot({ path: `test-results/mention-preview-${mobile ? "mobile" : "desktop"}.png` });
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.slug}/issues`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  const result = await (await saved).json();
  expect(result.issue.taggedUserIds).toEqual([id]);
  await expect(dialog.getByRole("link", { name: "View issue" })).toBeVisible();
  await dialog.getByRole("link", { name: "View issue" }).click();
  await expect(page.getByRole("list", { name: "Tagged users", exact: true })).toHaveCount(0);
  await page.locator(".detail-form").getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".detail-form .editor-preview .mention-chip")).toHaveCount(2);
  await page.screenshot({ path: `test-results/mention-saved-preview-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
});

test("comment UI adds, edits and deletes associations without replacing the unsaved issue draft", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Comment mentions ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Comment association test" } })).json();
  await page.goto(`/issues/${issue.id}`);
  const input = page.getByRole("textbox", { name: "Issue", exact: true });
  const draft = "Unsaved issue draft must survive every comment mutation #unsaved-label";
  await input.fill(draft);
  const tagged = page.getByRole("list", { name: "Tagged users", exact: true });
  await expect(tagged).toHaveCount(0);
  const expectDraft = async () => {
    await expect(input).toHaveText(draft);
    await expect(input).toContainText("#unsaved-label");
    const persisted = await (await page.request.get(`/api/issues/${issue.id}`)).json();
    expect(persisted.issue.body).toBe("Comment association test");
    expect(persisted.issue.labels).toEqual([]);
  };
  const composer = page.getByRole("textbox", { name: "Share an update or ask a question…" });
  await composer.fill("Please review @alex");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await composer.press("Tab");
  const link = composer.locator('[data-mention-user-id]');
  const id = await link.getAttribute("data-mention-user-id");
  const displayName = (await link.innerText()).slice(1);
  const posted = page.waitForResponse(response => response.url().endsWith(`/api/issues/${issue.id}/comments`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  const created = await (await posted).json();
  expect(created.issue.taggedUserIds).toEqual([id]);
  const comment = page.locator("article.comment");
  await expect(comment.locator(".mention-chip")).toHaveText(`@${displayName}`);
  await expect(tagged).toHaveCount(0);
  await expectDraft();

  await comment.getByRole("button", { name: "Edit comment", exact: true }).click();
  await comment.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = comment.getByRole("textbox", { name: "Markdown source" });
  await source.fill("Plain @Alex and `@Alex` are not mentions");
  const edited = page.waitForResponse(response => response.url().endsWith(`/api/comments/${created.comment.id}`) && response.request().method() === "PATCH");
  await comment.getByRole("button", { name: "Save comment", exact: true }).click();
  expect((await (await edited).json()).issue.taggedUserIds).toEqual([]);
  await expect(comment.locator(".mention-chip")).toHaveCount(0);
  await expect(tagged).toHaveCount(0);
  await expectDraft();

  // Add the mention back via actual source autocomplete, then remove by deleting the comment.
  await comment.getByRole("button", { name: "Edit comment", exact: true }).click();
  await comment.getByRole("button", { name: "Markdown", exact: true }).click();
  await source.fill("Restored @alex");
  await comment.getByRole("option").filter({ hasText: "alex@example.test" }).click();
  await comment.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(tagged).toHaveCount(0);
  await expectDraft();
  await comment.getByRole("button", { name: "Delete comment", exact: true }).click();
  const deleted = page.waitForResponse(response => response.url().endsWith(`/api/comments/${created.comment.id}`) && response.request().method() === "DELETE");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm delete", exact: true }).click();
  expect((await (await deleted).json()).issue.taggedUserIds).toEqual([]);
  await expect(comment).toHaveCount(0);
  await expect(tagged).toHaveCount(0);
  await expectDraft();
});
