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
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Details ${randomUUID()}` } })).json();
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Original body" } })).json();
  return { project, issue, headers };
}
async function visibleToast(page: Page, text: string) {
  const toast = page.locator("body > .snackbar .notification").filter({ hasText: text });
  await expect(toast).toBeVisible();
  await expect(toast).toBeInViewport({ ratio: 1 });
  // Assert actual paint/hit testing, not just nonzero layout outside a clipped panel.
  expect(await toast.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBeTruthy();
}
for (const embedded of [false, true]) {
  test(`${embedded ? "sidebar" : "full page"}: clean saves are no-ops, repeated dirty saves visibly notify, discard preserves comment and lifecycle`, async ({ page, baseURL }) => {
    const { issue, project } = await seed(page, baseURL!);
    await page.goto(embedded ? `/projects/${project.slug}` : `/issues/${issue.id}`);
    if (embedded) await page.locator(`a[data-issue-id="${issue.id}"]`).click();
    const detail = page.locator(".detail-container");
    const form = detail.locator(".detail-form");
    const save = form.getByRole("button", { name: "Save changes", exact: true });
    await expect(save).toBeDisabled();
    await form.getByRole("button", { name: "Markdown", exact: true }).click();
    const source = form.getByLabel("Markdown source");
    let writes = 0;
    page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith(`/api/issues/${issue.id}`)) writes++; });
    await source.press("Control+s");
    await page.waitForTimeout(150);
    expect(writes).toBe(0);
    for (const body of ["First save", "Second save"]) {
      await source.fill(body);
      await save.click();
      await expect(save).toBeDisabled();
      await visibleToast(page, "Changes saved");
    }
    expect(writes).toBe(2);
    await source.press("Control+s");
    await page.waitForTimeout(150);
    expect(writes).toBe(2);
    await source.fill("Discard this body only");
    const comment = detail.locator(".comments [contenteditable=true]");
    await comment.fill("Keep this comment draft");
    await form.getByRole("button", { name: "Close issue", exact: true }).click();
    await expect(form.getByRole("button", { name: "Reopen issue", exact: true })).toBeVisible();
    await form.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(source).toHaveValue("Second save");
    await expect(comment).toContainText("Keep this comment draft");
    await expect(save).toBeDisabled();
    const saved = (await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue;
    expect(saved.state).toBe("closed");
    expect(saved.body).toBe("Second save");
    await page.context().grantPermissions(["clipboard-write", "clipboard-read"]);
    await detail.getByRole("button", { name: "Copy issue body", exact: true }).click();
    await visibleToast(page, "Issue body copied to clipboard.");
  });
}
for (const embedded of [false, true]) {
test(`${embedded ? "sidebar" : "full page"}: move preserves identity and drafts, removes old placement, and supports No project`, async ({ page, baseURL }) => {
  const { issue, project, headers } = await seed(page, baseURL!);
  const { project: target } = await (await page.request.post("/api/projects", { headers, data: { name: `Target ${randomUUID()}` } })).json();
  const { board } = await (await page.request.get(`/api/projects/${project.slug}/board`)).json();
  expect((await page.request.put(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: [issue.id], lane: board.lanes[0] } })).ok()).toBeTruthy();
  await page.goto(embedded ? `/projects/${project.slug}` : `/issues/${issue.id}`);
  if (embedded) await page.locator(`a[data-issue-id="${issue.id}"]`).click();
  const form = page.locator(".detail-form");
  await form.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = form.getByLabel("Markdown source");
  await source.fill("Unsaved moved draft");
  const comment = page.locator(".comments [contenteditable=true]");
  await comment.fill("Unsaved discussion");
  await form.getByRole("button", { name: "Move issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move issue", exact: true });
  await expect(dialog.getByRole("button", { name: "Move issue", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("previous project’s board");
  await dialog.getByLabel("Destination project").selectOption(target.id);
  await dialog.getByRole("button", { name: "Move issue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await visibleToast(page, "Issue moved");
  await expect(source).toHaveValue("Unsaved moved draft");
  await expect(comment).toContainText("Unsaved discussion");
  await expect(page).toHaveURL(embedded ? `/projects/${project.slug}` : `/issues/${issue.id}`);
  const moved = (await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue;
  expect(moved.number).toBe(issue.number);
  expect(moved.projectId).toBe(target.id);
  expect(moved.body).toBe("Original body");
  const oldBoard = (await (await page.request.get(`/api/projects/${project.slug}/board`)).json()).board;
  expect(oldBoard.cards.some((card: { issueId: string }) => card.issueId === issue.id)).toBe(false);
  await form.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(source).toHaveValue("Original body");
  await expect(comment).toContainText("Unsaved discussion");
  await form.getByRole("button", { name: "Move issue", exact: true }).click();
  await dialog.getByLabel("Destination project").selectOption("");
  await dialog.getByRole("button", { name: "Move issue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Send to board", exact: true })).toBeDisabled();
  expect((await (await page.request.get(`/api/issues/${issue.id}`)).json()).issue.projectId).toBeNull();
});
}
