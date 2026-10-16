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
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Sub-issues ${randomUUID()}` } })).json();
  const create = async (body: string) => (await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body } })).json()).issue;
  const parent = await create("Parent work");
  const child = await create("Existing child work");
  return { project, parent, child, headers, create };
}

for (const embedded of [false, true]) {
  test(`${embedded ? "sidebar" : "full page"}: create, attach, progress, detach and parent navigation preserve unsaved drafts`, async ({ page, baseURL }) => {
    const { project, parent, child, headers } = await seed(page, baseURL!);
    await page.goto(embedded ? `/projects/${project.slug}` : `/issues/${parent.id}`);
    if (embedded) await page.locator(`a[data-issue-id="${parent.id}"]`).click();
    const detail = page.locator(".detail-container");
    const section = detail.getByRole("region", { name: "Issue relationships" });
    await expect(section.getByText("No sub-issues to show.", { exact: false })).toBeVisible();
    // The hierarchy belongs below the body, not inside the header or after discussion.
    expect(await detail.evaluate((node) => {
      const body = node.querySelector(".issue-detail-body")!;
      const relationships = node.querySelector(".issue-relationships")!;
      const comments = node.querySelector(".comments")!;
      return !!(body.compareDocumentPosition(relationships) & Node.DOCUMENT_POSITION_FOLLOWING)
        && !!(relationships.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBeTruthy();
    const form = detail.locator(".detail-form");
    await form.getByRole("button", { name: "Markdown", exact: true }).click();
    const body = form.getByLabel("Markdown source");
    await body.fill("Unsaved parent body");
    const comment = detail.locator(".comments [contenteditable=true]");
    await comment.fill("Unsaved comment");

    await section.getByRole("button", { name: "Add existing issue", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add existing sub-issue", exact: true });
    await picker.getByRole("searchbox", { name: "Find an issue" }).fill(`!${child.number}`);
    await picker.getByRole("button", { name: `Add !${child.number} ${child.title}`, exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(section.getByRole("link", { name: `!${child.number} ${child.title}`, exact: true })).toBeVisible();
    await expect(section.getByText("0 of 1 completed")).toBeVisible();
    await expect(body).toHaveValue("Unsaved parent body");
    await expect(comment).toContainText("Unsaved comment");

    await section.getByRole("button", { name: "Create sub-issue", exact: true }).click();
    const composer = page.getByRole("dialog", { name: "Create sub-issue", exact: true });
    await expect(composer.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(project.id);
    await expect(composer.getByRole("combobox", { name: "Visibility", exact: true })).toHaveCount(0);
    await composer.getByRole("button", { name: "Markdown", exact: true }).click();
    await composer.getByLabel("Markdown source").fill("New child work");
    await composer.getByRole("button", { name: "Create sub-issue", exact: true }).click();
    await expect(composer.getByText(/created\. Ready for another/)).toBeVisible();
    await composer.getByRole("button", { name: "Done", exact: true }).click();
    await expect(section.getByRole("link", { name: /New child work/ })).toBeVisible();
    await expect(section.getByText("0 of 2 completed")).toBeVisible();
    if (embedded) await expect(page.locator(".issue-table").getByRole("link", { name: /^!\d+ New child work$/ })).toBeVisible();
    await expect(body).toHaveValue("Unsaved parent body");
    await expect(comment).toContainText("Unsaved comment");

    expect((await page.request.patch(`/api/issues/${child.id}`, { headers, data: { state: "closed" } })).ok()).toBeTruthy();
    await section.getByRole("button", { name: "Refresh sub-issues" }).click();
    await expect(section.getByText("1 of 2 completed")).toBeVisible();
    await expect(section.getByRole("progressbar", { name: "Sub-issue completion" })).toHaveAttribute("value", "1");
    const relationships = await (await page.request.get(`/api/issues/${parent.id}/relationships`)).json();
    const created = relationships.subIssues.find((issue: { id: string }) => issue.id !== child.id);
    await section.getByRole("button", { name: `Remove sub-issue !${created.number}`, exact: true }).click();
    await expect(section.getByRole("link", { name: /New child work/ })).toHaveCount(0);
    expect((await page.request.get(`/api/issues/${created.id}`)).ok()).toBeTruthy();
    await expect(section.getByText("1 of 1 completed")).toBeVisible();

    const link = section.getByRole("link", { name: `!${child.number} ${child.title}`, exact: true });
    page.once("dialog", (dialog) => void dialog.dismiss());
    await link.click();
    await expect(body).toHaveValue("Unsaved parent body");
    page.once("dialog", (dialog) => void dialog.accept());
    await link.click();
    await expect(page).toHaveURL(`/issues/${child.id}`);
    const childSection = page.getByRole("region", { name: "Issue relationships" });
    await expect(childSection.getByText("Sub-issue of", { exact: true })).toBeVisible();
    await expect(childSection.getByRole("link", { name: `!${parent.number} ${parent.title}`, exact: true })).toBeVisible();
    await childSection.getByRole("button", { name: "Remove parent", exact: true }).click();
    await expect(childSection.getByText("Sub-issue of", { exact: true })).toHaveCount(0);
    expect((await (await page.request.get(`/api/issues/${parent.id}/relationships`)).json()).subIssues).toEqual([]);
    expect((await (await page.request.get(`/api/issues/${parent.id}`)).json()).issue.body).toBe("Parent work");
  });
}

test("nested cycles and already-parented issues explain failures without closing picker", async ({ page, baseURL }) => {
  const { parent, child, headers, create } = await seed(page, baseURL!);
  const grandchild = await create("Grandchild work");
  expect((await page.request.post(`/api/issues/${parent.id}/sub-issues`, { headers, data: { issueId: child.id } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/issues/${child.id}/sub-issues`, { headers, data: { issueId: grandchild.id } })).ok()).toBeTruthy();
  await page.goto(`/issues/${grandchild.id}`);
  const section = page.getByRole("region", { name: "Issue relationships" });
  await section.getByRole("button", { name: "Add existing issue" }).click();
  const picker = page.getByRole("dialog", { name: "Add existing sub-issue" });
  await picker.getByRole("searchbox").fill(`!${parent.number}`);
  await picker.getByRole("button", { name: `Add !${parent.number} ${parent.title}`, exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText(/cycle/i);
  await expect(picker).toBeVisible();
  await picker.getByRole("searchbox").fill(`!${child.number}`);
  await picker.getByRole("button", { name: `Add !${child.number} ${child.title}`, exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText(/parent/i);
  expect((await (await page.request.get(`/api/issues/${grandchild.id}/relationships`)).json()).subIssues).toEqual([]);
});

test("mobile relationships, read-only archive, drafts and unlinked parent creation", async ({ page, baseURL }) => {
  const { project, parent, child, headers } = await seed(page, baseURL!);
  expect((await page.request.post(`/api/issues/${parent.id}/sub-issues`, { headers, data: { issueId: child.id } })).ok()).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/issues/${parent.id}`);
  const section = page.getByRole("region", { name: "Issue relationships" });
  await expect(section.getByRole("link", { name: `!${child.number} ${child.title}`, exact: true })).toBeVisible();
  expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  await section.getByRole("button", { name: "Create sub-issue", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Create sub-issue", exact: true });
  await expect(composer).toBeVisible();
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.reload();
  await expect(section.getByRole("link", { name: `!${child.number} ${child.title}`, exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Add existing issue" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: /Remove sub-issue/ })).toHaveCount(0);

  const { issue: draft } = await (await page.request.post("/api/issues", { headers, data: { body: "Personal draft", state: "draft" } })).json();
  await page.goto(`/issues/${draft.id}`);
  await expect(page.getByRole("button", { name: "Publish issue", exact: true })).toBeVisible();
  await expect(section).toHaveCount(0);
  const { issue: unlinked } = await (await page.request.post("/api/issues", { headers, data: { body: "No project parent" } })).json();
  await page.goto(`/issues/${unlinked.id}`);
  await section.getByRole("button", { name: "Create sub-issue", exact: true }).click();
  await expect(composer.getByRole("combobox", { name: "Project", exact: true })).toHaveValue("");
});
