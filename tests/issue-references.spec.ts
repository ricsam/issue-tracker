import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const auth = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(auth.ok()).toBeTruthy(); session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

for (const mobile of [false, true]) test(`global issue numbers, ! autocomplete, rendered links and canonical URLs${mobile ? " on mobile" : ""}`, async ({ page, baseURL }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const headers = { Origin: baseURL! };
  const suffix = randomUUID();
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: `References ${suffix}` } })).json()).project;
  const target = (await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Reference target ${suffix}\n\n#bug` } })).json()).issue;
  const unlinked = (await (await page.request.post("/api/issues", { headers, data: { body: `Unlinked reference ${suffix}` } })).json()).issue;
  expect(target.id).toBe(String(target.number));
  expect(unlinked.number).toBe(target.number + 1);
  expect(unlinked.id).toMatch(/^[1-9]\d*$/);
  await page.goto(`/issues/${unlinked.id}`);
  await expect(page.locator(".eyebrow")).toHaveText(`ISSUE !${unlinked.number}`);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  const picker = page.getByRole("listbox", { name: "Issue suggestions" });
  await editor.fill(`Related issue\n\nSee !Reference target ${suffix}`);
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker).toContainText(`!${target.number}`);
  await expect(editor).toHaveAttribute("aria-controls", (await picker.getAttribute("id"))!);
  await page.screenshot({ path: testInfo.outputPath(`references-${mobile ? "mobile" : "desktop"}.png`) });
  if (mobile) await picker.getByRole("option").click();
  else await editor.press("Enter");
  await expect(picker).toBeHidden();
  await expect(editor.locator(".issue-reference-chip")).toHaveText(`!${target.number}`);
  await expect(editor.locator(".issue-reference-chip")).toHaveAttribute("data-issue-reference-id", target.id);
  const richEditor = page.locator(".detail-form .rich-editor");
  await richEditor.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = richEditor.getByRole("textbox", { name: "Markdown source" });
  expect(await source.inputValue()).toContain(`See !${target.number}`);
  for (const suffix of ["`!12", "```\n!12", "![image", "[link !12", "[link](https://example.test/!12", "word!12", "\\!12"] ) {
    await source.fill(`Related issue\n\n${suffix}`); await expect(picker).toBeHidden();
  }
  await source.fill("Related issue\n\n@alex");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await source.fill(`Related issue\n\n!${target.number}`);
  await expect(picker).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeHidden();
  await source.press("Escape"); await expect(picker).toBeHidden();
  await source.fill(`Related issue\n\nSee !Reference target ${suffix}`);
  await expect(picker.getByRole("option")).toHaveCount(1);
  await source.press("Tab"); await expect(picker).toBeHidden();
  await source.fill(`Related issue\n\nSee !${target.number} and #bug.\n\n\`!${target.number}\`\n\n![image](/api/uploads/example/image.png)`);
  await richEditor.getByRole("button", { name: "Preview", exact: true }).click();
  const reference = richEditor.locator(".editor-preview .issue-reference-chip");
  await expect(reference).toHaveCount(1);
  await expect(reference).toHaveAttribute("href", `/issues/${target.id}`);
  await expect(richEditor.locator(".editor-preview .hashtag-chip")).toHaveText("#bug");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  const saved = (await (await page.request.get(`/api/issues/${unlinked.id}`)).json()).issue;
  expect(saved.body).toContain(`See !${target.number}`);
  expect(saved.labels).toEqual(["bug"]);
  await reference.click();
  await expect(page).toHaveURL(`${baseURL}/issues/${target.id}`);
  await expect(page.locator(".eyebrow")).toHaveText(`ISSUE !${target.number}`);
  expect(errors).toEqual([]);
});

test("rich references can be extended, saved, followed and used in comments", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const target = (await (await page.request.post("/api/issues", { headers, data: { body: `Clickable target ${randomUUID()}` } })).json()).issue;
  const issue = (await (await page.request.post("/api/issues", { headers, data: { body: `Reference editing\n\n!${target.number}` } })).json()).issue;
  await page.goto(`/issues/${issue.id}`);
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  const reference = editor.locator(".issue-reference-chip");
  await expect(reference).toHaveText(`!${target.number}`);
  await editor.click(); await editor.press("Control+End"); await editor.pressSequentially("9");
  await expect(reference).toHaveText(`!${target.number}9`);
  await expect(reference).toHaveAttribute("data-issue-reference-id", `${target.number}9`);
  await editor.press("Backspace"); await editor.pressSequentially(" ");
  await expect(page.getByRole("listbox", { name: "Issue suggestions" })).toBeHidden();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  const comment = page.getByRole("textbox", { name: "Share an update or ask a question…", exact: true });
  await comment.fill(`Comment references !${target.number}`);
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.locator(".comments .markdown-content .issue-reference-chip")).toHaveAttribute("href", `/issues/${target.id}`);
  // Rich Write-mode references, not only preview links, are navigable.
  await reference.focus();
  await reference.press("Enter");
  await expect(page).toHaveURL(`${baseURL}/issues/${target.id}`);
});

test("UUID issue URLs show not found without redirecting or leaving the page loading", async ({ page, baseURL }) => {
  const oldId = randomUUID();
  await page.goto(`/issues/${oldId}`);
  await expect(page).toHaveURL(`${baseURL}/issues/${oldId}`);
  await expect(page.getByRole("alert")).toContainText("Issue not found");
  await expect(page.locator(".issue-detail-loader")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toHaveCount(0);
});
