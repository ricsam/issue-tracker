import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

test("body hashtags derive labels across rich creation, source editing and reload; code is excluded", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Hashtags ${randomUUID()}` } })).json();
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Labels", exact: true })).toHaveCount(0);
  // Lexical exports escaped punctuation; the shared parser must use semantic text.
  await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Rich issue #bug #design");
  await expect(dialog.getByRole("list", { name: "Labels", exact: true })).toHaveCount(0);
  const creation = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/api/projects/${project.slug}/issues`));
  await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
  expect((await creation).postDataJSON()).not.toHaveProperty("labels");
  await expect(dialog.getByRole("status")).toContainText("Issue #1 created");
  const { issues } = await (await page.request.get(`/api/projects/${project.slug}/issues`)).json();
  expect(issues[0].labels).toEqual(["bug", "design"]);
  await dialog.getByRole("link", { name: "View issue" }).click();
  const form = page.locator(".detail-form");
  await expect(form.getByRole("textbox", { name: "Labels", exact: true })).toHaveCount(0);
  await expect(page.locator(".back-link")).toHaveCount(0);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
  await expect(breadcrumb).toContainText("Issue #1");
  await expect(breadcrumb.getByRole("link", { name: project.name, exact: true })).toHaveAttribute("href", `/projects/${project.slug}`);
  await page.screenshot({ path: "test-results/clean-issue-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Wait for the existing responsive navigation transition before capturing.
  await expect.poll(async () => {
    const box = (await page.locator(".sidebar").boundingBox())!;
    return box.x + box.width;
  }).toBeLessThanOrEqual(0);
  await expect(breadcrumb).toContainText("Issue #1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/clean-issue-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("heading", { name: "Properties", exact: true })).toHaveCount(0);
  await expect(page.locator(".properties, .detail-grid")).toHaveCount(0);
  await expect(form.locator(".detail-title")).toContainText("Created");
  await expect(form.locator(".detail-title")).toContainText("Alex Morgan");
  await expect(page.getByRole("heading", { name: /Discussion/ })).toHaveCount(0);
  await expect(page.getByText("No comments yet. Start the conversation.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".comments legend")).toHaveClass("sr-only");
  await expect(page.locator(".comments .editor-input")).toBeVisible();
  await expect(page.getByText("No tagged users", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Markdown", exact: true }).click();
  const body = "# Updated issue\n\nNeeds #triage and #triage. `#inline-code`\n\n```text\n#fenced-code\n```\n\n#release";
  await form.getByLabel("Markdown source").fill(body);
  const chips = form.getByRole("list", { name: "Labels", exact: true }).getByRole("listitem");
  await expect(chips).toHaveCount(0);
  const save = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith(`/api/issues/${issues[0].id}`));
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await save).postDataJSON()).toEqual({ body });
  await expect(form.getByRole("status")).toHaveText("Changes saved");
  expect((await (await page.request.get(`/api/issues/${issues[0].id}`)).json()).issue.labels).toEqual(["triage", "release"]);
  await page.reload();
  await expect(form.getByRole("textbox", { name: "Issue", exact: true })).toContainText("#triage");
  await expect(chips).toHaveCount(0);
  await form.getByRole("button", { name: "Markdown", exact: true }).click();
  await form.getByLabel("Markdown source").fill("No labels remain\n\n`#code-only`");
  await expect(chips).toHaveCount(0);
  await expect(form.getByRole("list", { name: "Labels", exact: true })).toHaveCount(0);
  await expect(page.getByText("No labels", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Changes saved");
  expect((await (await page.request.get(`/api/issues/${issues[0].id}`)).json()).issue.labels).toEqual([]);
});
