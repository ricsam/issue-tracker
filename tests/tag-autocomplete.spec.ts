import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

// Independent project and seed issues: no dependency on other specs' data/order.
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

test("existing tags complete in rich and source modes without competing mention ARIA", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const response = await page.request.post("/api/projects", { headers, data: { name: `Tag completion ${randomUUID()}` } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  const seeded = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Tag catalog\n\n#bug #build #multi-word #Bad #bug_bad #日本語 #[multi%20word]" } });
  expect(seeded.ok()).toBeTruthy();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const editor = dialog.getByRole("textbox", { name: "Issue", exact: true });
  const tags = dialog.getByRole("listbox", { name: "Tag suggestions" });
  const invalidPrefixes = ["#B", "#buG", "#bu_g", "#bug--", "#-bug", "#日本", "#[multi", "#[multi wo", "#[multi%20"];
  for (const prefix of invalidPrefixes) {
    await editor.fill(`Tag regression\n\n${prefix}`);
    await expect(tags).toBeHidden();
  }
  await editor.fill("Tag regression\n\n#");
  await expect(tags.getByRole("option")).toHaveText(["#bug", "#build", "#multi-word"]);
  await editor.fill("Tag regression\n\nKeep #b");
  await expect(tags.getByRole("option")).toHaveCount(2);
  await expect(editor).toHaveAttribute("aria-controls", (await tags.getAttribute("id"))!);
  await editor.press("ArrowDown"); await editor.press("ArrowUp");
  const chosen = await tags.locator('[aria-selected="true"]').innerText();
  await editor.press("Enter");
  await expect(tags).toBeHidden(); await expect(editor).toContainText(`Keep ${chosen}`);
  await editor.press("End"); await editor.pressSequentially(" #multi-");
  await expect(tags.getByRole("option", { name: "#multi-word", exact: true })).toBeVisible();
  await editor.press("Tab"); await expect(tags).toBeHidden();
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = dialog.getByRole("textbox", { name: "Markdown source" });
  expect(await source.inputValue()).toContain("#multi-word");
  for (const prefix of invalidPrefixes) {
    await source.fill(`Tag regression\n\n${prefix}`);
    await expect(tags).toBeHidden();
  }
  await source.fill("Tag regression\n\n#");
  await expect(tags.getByRole("option")).toHaveText(["#bug", "#build", "#multi-word"]);
  for (const suffix of ["`#bu", "```\n#bu", "[link #bu", "[link](https://example.test/#bu", "word#bu", "\\#bu"]) {
    await source.fill(`Tag regression\n\n${suffix}`); await expect(tags).toBeHidden();
  }
  await source.fill("Tag regression\n\n#multi-");
  await expect(tags).toBeVisible();
  await source.press("Escape"); await expect(tags).toBeHidden(); await expect(dialog).toBeVisible();
  await source.fill("Tag regression\n\n#multi");
  await tags.getByRole("option", { name: "#multi-word", exact: true }).click();
  await expect(source).toHaveValue("Tag regression\n\n#multi-word ");
  await source.fill("Tag regression\n\n@alex");
  const mentions = dialog.getByRole("listbox", { name: "Mention suggestions" });
  await expect(mentions).toBeVisible();
  await expect(source).toHaveAttribute("aria-controls", (await mentions.getAttribute("id"))!);
  await source.fill("Tag regression\n\n#bu");
  await expect(tags).toBeVisible(); await expect(mentions).toBeHidden();
  await expect(source).toHaveAttribute("aria-controls", (await tags.getAttribute("id"))!);
  await source.press("Tab");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.locator(".editor-preview .hashtag-chip")).toHaveCount(1);
});
