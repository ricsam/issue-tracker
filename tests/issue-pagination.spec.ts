import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { issuePageSizeStorageKey } from "../src/lib/issue-pagination";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let userId: string;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(response.ok()).toBeTruthy();
  userId = (await response.json()).user.id;
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

test("rows per page persists per list across navigation, reload, view changes and renames", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const projects = [];
  for (const prefix of ["Page A", "Page B"]) projects.push((await (await page.request.post("/api/projects", { headers, data: { name: `${prefix} ${randomUUID()}` } })).json()).project);
  const [a, b] = projects;
  for (let i = 0; i < 12; i++) await page.request.post(`/api/projects/${a.slug}/issues`, { headers, data: { body: `Pagination ${i}` } });
  const rows = page.getByLabel("Rows per page");
  await page.goto(`/projects/${a.slug}`);
  await expect(rows).toHaveValue("25");
  await rows.selectOption("10");
  await expect(page.locator("tbody .issue-link")).toHaveCount(10);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await rows.selectOption("50");
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(rows).toHaveValue("50");
  await page.getByRole("link", { name: /^Closed/ }).click();
  await expect(rows).toHaveValue("50");
  await page.goto(`/projects/${b.slug}`);
  await expect(rows).toHaveValue("25");
  await rows.selectOption("100");
  await page.goto("/issues");
  await expect(rows).toHaveValue("25");
  await rows.selectOption("10");
  await page.reload();
  await expect(rows).toHaveValue("10");
  await page.goto(`/projects/${a.slug}`);
  await expect(rows).toHaveValue("50");
  const { project: renamed } = await (await page.request.patch(`/api/projects/${a.slug}`, { headers, data: { name: `Renamed ${randomUUID()}` } })).json();
  await page.goto(`/projects/${renamed.slug}`);
  await expect(rows).toHaveValue("50");
  await page.goto(`/projects/${b.slug}`);
  await expect(rows).toHaveValue("100");
});

test("corrupt, unsupported and another user's preferences safely fall back", async ({ page }) => {
  await page.goto("/issues");
  const key = issuePageSizeStorageKey(userId, "all");
  for (const value of ["{broken", "0", "10000", '"50"', "null"]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value });
    await page.reload();
    await expect(page.getByLabel("Rows per page")).toHaveValue("25");
  }
  await page.evaluate(({ key, other }) => { localStorage.removeItem(key); localStorage.setItem(other, "100"); }, { key, other: issuePageSizeStorageKey("another-user", "all") });
  await page.reload();
  await expect(page.getByLabel("Rows per page")).toHaveValue("25");
});

test("blocked browser storage keeps pagination usable for the visit", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await page.goto("/issues");
  await expect(page.getByLabel("Rows per page")).toHaveValue("25");
  await page.getByLabel("Rows per page").selectOption("50");
  await expect(page.getByLabel("Rows per page")).toHaveValue("50");
  await expect(page.getByRole("alert")).toContainText("browser storage is unavailable");
});
