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

for (const mobile of [false, true]) test(`colored hashtags remain editable, render in preview and survive saving${mobile ? " on mobile" : ""}`, async ({ page, baseURL }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { project } = await (await page.request.post("/api/projects", {
    headers: { Origin: baseURL! }, data: { name: `Tag styling ${randomUUID()}` },
  })).json();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const editor = dialog.getByRole("textbox", { name: "Issue", exact: true });
  for (const copy of ["Write your issue in one place.", "Hashtags inside code are ignored.", "Place it on the board later", "Markdown supported."]) {
    await expect(dialog).not.toContainText(copy);
  }
  await expect(editor).not.toHaveAttribute("aria-describedby");
  await expect(dialog).not.toHaveAttribute("aria-describedby");
  await editor.pressSequentially("#bug");
  await expect(editor.locator(".hashtag-chip")).toHaveText("#bug");
  await expect(editor.locator(".hashtag-chip")).toHaveCSS("background-color", "rgb(237, 233, 254)");
  await editor.pressSequentially("-fix plain");
  await expect(editor).toHaveText("#bug-fix plain");
  await expect(editor.locator(".hashtag-chip")).toHaveText("#bug-fix");
  await editor.press("Home");
  await editor.press("Delete");
  await expect(editor).toHaveText("bug-fix plain");
  await expect(editor.locator(".hashtag-chip")).toHaveCount(0);
  await editor.pressSequentially("#");
  await expect(editor.locator(".hashtag-chip")).toHaveText("#bug-fix");
  await editor.press("Home");
  await editor.pressSequentially("word");
  await expect(editor.locator(".hashtag-chip")).toHaveCount(0);
  await editor.pressSequentially(" ");
  await expect(editor.locator(".hashtag-chip")).toHaveText("#bug-fix");
  await editor.press("ControlOrMeta+a");
  await dialog.getByRole("button", { name: "Inline code", exact: true }).click();
  await expect(editor.locator(".hashtag-chip")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Inline code", exact: true }).click();
  await expect(editor.locator(".hashtag-chip")).toHaveText("#bug-fix");

  const invalid = ["#bugFix", "#bug_bad", "#bug--fix", "#-bug", "#bug-", "#日本語", "#[needs review]", "#[needs%20review]"];
  // Editing a previously valid chip into an invalid full token must remove styling,
  // rather than retaining a chip on its valid-looking prefix.
  for (const token of invalid) {
    await editor.fill(token);
    await expect(editor).toHaveText(token);
    await expect(editor.locator(".hashtag-chip")).toHaveCount(0);
  }
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  const markdown = `# Colored labels\n\nPlease review #bug #needs-review #release-2 ${invalid.join(" ")} \\#migrated and **#bold**.\n\n\`#code\`\n\n\`\`\`text\n#fenced\n\`\`\`\n\n[#linked](https://example.test/#anchor) https://example.test/#url`;
  await dialog.getByLabel("Markdown source").fill(markdown);
  await dialog.getByRole("button", { name: "Write", exact: true }).click();
  const expected = ["#bug", "#needs-review", "#release-2", "#migrated", "#bold"];
  for (const token of invalid) await expect(editor).toContainText(token);
  await expect(editor.locator(".hashtag-chip")).toHaveText(expected);
  await page.screenshot({ path: testInfo.outputPath(`colored-tags-${mobile ? "mobile" : "desktop"}.png`) });
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.locator(".editor-preview .hashtag-chip")).toHaveText(expected);
  await expect(dialog.locator(".editor-preview code .hashtag-chip, .editor-preview a .hashtag-chip")).toHaveCount(0);
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.slug}/issues`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  const { issue } = await (await saved).json();
  expect(issue.labels).toEqual(["bug", "needs-review", "release-2", "migrated", "bold"]);
  expect(issue.body).toBe(markdown);
  await dialog.getByRole("link", { name: "View issue" }).click();
  const detail = page.locator(".detail-form");
  await expect(detail.locator(".editor-preview .hashtag-chip")).toHaveText(expected);
  await detail.getByRole("button", { name: "Write", exact: true }).click();
  await expect(detail.locator(".editor-input .hashtag-chip")).toHaveText(expected);
  await detail.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(detail.locator(".editor-preview .hashtag-chip")).toHaveText(expected);
  await page.goto(`/issues/${issue.id}`);
  await expect(detail.locator(".editor-preview .hashtag-chip")).toHaveText(expected);
  for (const token of invalid) await expect(detail.locator(".editor-preview")).toContainText(token);
  expect(errors).toEqual([]);
});
