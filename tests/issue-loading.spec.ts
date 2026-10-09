import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Loading ${randomUUID()}` } })).json();
  const ids: string[] = [];
  const numbers: number[] = [];
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: title } });
    expect(response.ok()).toBeTruthy();
    const { issue } = await response.json(); ids.push(issue.id); numbers.push(issue.number);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}`);
  return { project, ids, numbers, headers };
}
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Issue details", exact: true });
const editor = (page: Page) => sidebar(page).locator('.detail-form [contenteditable="true"]');
const open = (page: Page, number: number, title: string) => page.getByRole("link", { name: `!${number} ${title}`, exact: true }).click();

for (const reducedMotion of [false, true]) {
  test(`switching retains the editor and fades without a workspace spinner (reduced motion: ${reducedMotion})`, async ({ page, baseURL }) => {
    const { ids, numbers } = await seed(page, baseURL!);
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    await open(page, numbers[0], "Alpha");
    await expect(editor(page)).toContainText("Alpha");
    const previous = await editor(page).elementHandle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/issues/${ids[1]}`, async (route) => { await gate; await route.continue(); });
    await open(page, numbers[1], "Beta");
    await expect(sidebar(page).getByRole("status", { name: "Loading issue", exact: true })).toBeVisible();
    await expect(editor(page)).toContainText("Alpha");
    expect(await previous!.evaluate((node) => node.isConnected)).toBeTruthy();
    await expect(sidebar(page).locator(".issue-detail-content")).toHaveAttribute("inert", "");
    await expect(sidebar(page).locator(".loading")).toHaveCount(0);
    await expect(sidebar(page).locator(".issue-detail-content")).toHaveCSS("opacity", "0.5");
    await expect(sidebar(page).locator(".issue-load-progress")).toHaveCSS("opacity", "1");
    release();
    await expect(editor(page)).toContainText("Beta");
    await expect(sidebar(page).locator(".issue-detail-content")).not.toHaveAttribute("inert", "");
    await expect(sidebar(page).locator(".issue-detail-content")).toHaveCSS("opacity", "1");
    await expect(sidebar(page).getByRole("status", { name: "Loading issue", exact: true })).toHaveCount(0);
    expect(await previous!.evaluate((node) => node.isConnected)).toBeFalsy();
    // New issue means a new Lexical history; undo cannot restore another issue.
    await editor(page).focus();
    await page.keyboard.press("Control+z");
    await expect(editor(page)).toContainText("Beta");
  });
}

test("failed loads keep previous content inert, retry successfully, and late responses cannot replace the latest selection", async ({ page, baseURL }) => {
  const { ids, numbers } = await seed(page, baseURL!);
  await open(page, numbers[0], "Alpha");
  await expect(editor(page)).toContainText("Alpha");
  await page.route(`**/api/issues/${ids[1]}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Try again later" }) }));
  await open(page, numbers[1], "Beta");
  await expect(sidebar(page).getByRole("alert")).toContainText("Could not load the selected issue");
  await expect(editor(page)).toContainText("Alpha");
  await expect(sidebar(page).locator(".issue-detail-content")).toHaveAttribute("inert", "");
  await page.unroute(`**/api/issues/${ids[1]}`);
  await sidebar(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(editor(page)).toContainText("Beta");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const alphaResponse = await (await page.request.get(`/api/issues/${ids[0]}`)).json();
  await page.route(`**/api/issues/${ids[0]}`, async (route) => { await gate; await route.fulfill({ json: alphaResponse }); });
  await open(page, numbers[0], "Alpha");
  await expect(sidebar(page).locator(".issue-detail-content")).toHaveAttribute("inert", "");
  await open(page, numbers[2], "Gamma");
  await expect(editor(page)).toContainText("Gamma");
  release();
  await page.waitForTimeout(150);
  await expect(editor(page)).toContainText("Gamma");
  await expect(sidebar(page).getByRole("link", { name: "Open issue in full page" })).toHaveAttribute("href", `/issues/${ids[2]}`);
});

test("bulk close confirms pending drafts and keeps board membership", async ({ page, baseURL }) => {
  const { project, ids, headers, numbers } = await seed(page, baseURL!);
  expect((await page.request.post(`/api/projects/${project.slug}/board/issues`, { headers, data: { issueIds: ids.slice(0, 2), lane: "todo" } })).ok()).toBeTruthy();
  await open(page, numbers[0], "Alpha");
  await editor(page).fill("Unsaved draft");
  await page.getByRole("checkbox", { name: `Select issue !${numbers[0]}`, exact: true }).check();
  await page.getByRole("checkbox", { name: `Select issue !${numbers[1]}`, exact: true }).check();
  let accept = false;
  page.on("dialog", (dialog) => accept ? dialog.accept() : dialog.dismiss());
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(editor(page)).toContainText("Unsaved draft");
  await expect(page.locator(".issue-row")).toHaveCount(3);
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  accept = true;
  await page.getByRole("button", { name: "Close selected issues" }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(page.locator(".issue-bulk-outcome")).toHaveText("2 issues closed.");
  const { board } = await (await page.request.get(`/api/projects/${project.slug}/board`)).json();
  expect(board.cards.map((card: { issueId: string }) => card.issueId).sort()).toEqual(ids.slice(0, 2).sort());
  const { issue } = await (await page.request.get(`/api/issues/${ids[0]}`)).json();
  expect(issue.state).toBe("closed");
  expect(issue.body).toBe("Alpha");
  await page.getByRole("navigation", { name: "Issue state" }).getByRole("link", { name: /Closed/ }).click();
  await expect(page.locator(".issue-row")).toHaveCount(2);
});
