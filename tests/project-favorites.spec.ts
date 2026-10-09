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
  const result = await page.request.post("/api/projects", { headers, data: { name: `Favorite ${randomUUID()}` } });
  expect(result.ok()).toBeTruthy();
  return { project: (await result.json()).project, headers };
}

for (const width of [1440, 390]) {
  test(`favorites persist and provide quick access at ${width}px`, async ({ page, baseURL }) => {
    const { project } = await seed(page, baseURL!);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    const card = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) });
    await card.getByRole("button", { name: `Favorite ${project.name}`, exact: true }).click();
    // A card's star is independent of its navigation link.
    await expect(page).toHaveURL("/projects");
    await expect(card.getByRole("button", { name: `Unfavorite ${project.name}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    const favorites = page.getByRole("region", { name: "Favorite projects", exact: true });
    await expect(favorites.getByRole("link", { name: project.name, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Other projects", exact: true }).getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
    await favorites.getByRole("link", { name: project.name, exact: true }).click();
    await expect(page).toHaveURL(`/projects/${project.slug}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    await favorites.getByRole("button", { name: `Unfavorite ${project.name}`, exact: true }).click();
    await expect(favorites.getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Other projects", exact: true }).getByRole("link", { name: project.name, exact: true })).toBeVisible();
  });
}

test("favorites are personal and archived favorites return on restore", async ({ page, browser, baseURL }) => {
  const { project, headers } = await seed(page, baseURL!);
  expect((await page.request.put(`/api/me/favorite-projects/${project.id}`, { headers })).ok()).toBeTruthy();
  const email = `favorites-${randomUUID()}@example.test`;
  expect((await page.request.post("/api/admin/users", { headers, data: { name: "Another member", email, password: "another-browser-test-password" } })).ok()).toBeTruthy();
  const other = await browser.newContext({ baseURL });
  try {
    expect((await other.request.post("/api/auth/login", { headers, data: { email, password: "another-browser-test-password" } })).ok()).toBeTruthy();
    const otherPage = await other.newPage();
    await otherPage.goto("/projects");
    await expect(otherPage.getByRole("region", { name: "Favorite projects", exact: true })).toContainText("Star a project");
    expect((await (await other.request.get("/api/me/favorite-projects")).json()).projectIds).not.toContain(project.id);
  } finally { await other.close(); }
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.goto("/projects");
  const favorites = page.getByRole("region", { name: "Favorite projects", exact: true });
  await expect(favorites.getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
  await page.goto("/projects?view=archived");
  const card = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) });
  await expect(card.getByRole("button", { name: `Unfavorite ${project.name}`, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: false } })).ok()).toBeTruthy();
  await page.reload();
  await expect(favorites.getByRole("link", { name: project.name, exact: true })).toBeVisible();
});

test("failed favorite writes preserve state and initial load errors are retryable", async ({ page, baseURL }) => {
  const { project } = await seed(page, baseURL!);
  await page.route("**/api/me/favorite-projects", (route) => route.fulfill({ status: 503, json: { error: "Try later" } }));
  await page.goto("/projects");
  const nav = page.getByRole("region", { name: "Favorite projects", exact: true });
  await expect(nav.getByRole("alert")).toContainText("Could not load favorites");
  await page.unroute("**/api/me/favorite-projects");
  await nav.getByRole("button", { name: "Retry favorites", exact: true }).click();
  const star = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) }).getByRole("button");
  await expect(star).toBeEnabled();
  await page.route(`**/api/me/favorite-projects/${project.id}`, (route) => route.fulfill({ status: 503, json: { error: "Try later" } }));
  await star.click();
  await expect(page.locator('.snackbar [role="alert"]')).toContainText("Could not update favorites");
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(star).toBeEnabled();
  await page.unroute(`**/api/me/favorite-projects/${project.id}`);
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
});

test("projects is the root breadcrumb and redundant sidebar copy is removed", async ({ page, baseURL }) => {
  const { project, headers } = await seed(page, baseURL!);
  await page.goto("/");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
  await expect(breadcrumb).toHaveText("Projects");
  await expect(page.getByText("Team workspace", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Let’s make progress", { exact: true })).toHaveCount(0);
  const { issue } = await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: "Breadcrumb issue" } })).json();
  await page.goto(`/issues/${issue.id}`);
  await expect(breadcrumb).not.toContainText("Workspace");
  await expect(breadcrumb.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("href", "/projects");
  await expect(breadcrumb.getByRole("link", { name: project.name, exact: true })).toHaveAttribute("href", `/projects/${project.slug}`);
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(`Issue !${issue.number}`);
});
