import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { Project } from "../shared/types";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! }, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context, page, baseURL }) => {
  await context.addCookies(session.cookies);
  const { projectIds } = await (await page.request.get("/api/me/pinned-projects")).json();
  for (const id of projectIds) expect((await page.request.delete(`/api/me/pinned-projects/${id}`, { headers: { Origin: baseURL! } })).ok()).toBeTruthy();
});
async function seed(page: Page, baseURL: string, label = "Project") {
  const headers = { Origin: baseURL };
  const result = await page.request.post("/api/projects", { headers, data: { name: `${label} ${randomUUID().slice(0, 8)}` } });
  expect(result.ok()).toBeTruthy();
  return { project: (await result.json()).project as Project, headers };
}
const pinnedRegion = (page: Page) => page.getByRole("region", { name: "Pinned projects", exact: true });
const otherRegion = (page: Page) => page.getByRole("region", { name: "Other projects", exact: true });
const row = (section: Locator, project: Project) => section.locator(`[data-project-id="${project.id}"]`);
const expectOrder = (section: Locator, projects: Project[]) => expect(section.getByRole("link")).toHaveText(projects.map((project) => project.name));
async function pin(page: Page, baseURL: string, project: Project) {
  expect((await page.request.put(`/api/me/pinned-projects/${project.id}`, { headers: { Origin: baseURL } })).ok()).toBeTruthy();
}

for (const width of [1440, 390]) {
  test(`pins persist and provide quick access at ${width}px`, async ({ page, baseURL }) => {
    const { project } = await seed(page, baseURL!);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    const card = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) });
    await card.getByRole("button", { name: `Pin ${project.name}`, exact: true }).click();
    // A card's pin is independent of its navigation link.
    await expect(page).toHaveURL("/projects");
    await expect(card.getByRole("button", { name: `Unpin ${project.name}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    const pins = pinnedRegion(page);
    await expect(pins.getByRole("link", { name: project.name, exact: true })).toBeVisible();
    await expect(otherRegion(page).getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
    await pins.getByRole("link", { name: project.name, exact: true }).click();
    await expect(page).toHaveURL(`/projects/${project.slug}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    await pins.getByRole("button", { name: `Unpin ${project.name}`, exact: true }).click();
    await expect(pins.getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
    await expect(otherRegion(page).getByRole("link", { name: project.name, exact: true })).toBeVisible();
  });
}

test("pins are personal and archived pins return on restore", async ({ page, browser, baseURL }) => {
  const { project, headers } = await seed(page, baseURL!);
  await pin(page, baseURL!, project);
  const email = `pins-${randomUUID()}@example.test`;
  expect((await page.request.post("/api/admin/users", { headers, data: { name: "Another member", email, password: "another-browser-test-password" } })).ok()).toBeTruthy();
  const other = await browser.newContext({ baseURL });
  try {
    expect((await other.request.post("/api/auth/login", { headers, data: { email, password: "another-browser-test-password" } })).ok()).toBeTruthy();
    const otherPage = await other.newPage();
    await otherPage.goto("/projects");
    await expect(pinnedRegion(otherPage)).toContainText("Drag projects here");
    expect((await (await other.request.get("/api/me/pinned-projects")).json()).projectIds).not.toContain(project.id);
  } finally { await other.close(); }
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: true } })).ok()).toBeTruthy();
  await page.goto("/projects");
  const pins = pinnedRegion(page);
  await expect(pins.getByRole("link", { name: project.name, exact: true })).toHaveCount(0);
  await page.goto("/projects?view=archived");
  const card = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) });
  await expect(card.getByRole("button", { name: `Unpin ${project.name}`, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await page.request.patch(`/api/projects/${project.slug}`, { headers, data: { archived: false } })).ok()).toBeTruthy();
  await page.reload();
  await expect(pins.getByRole("link", { name: project.name, exact: true })).toBeVisible();
});

test("failed pin writes preserve state and initial load errors are retryable", async ({ page, baseURL }) => {
  const { project } = await seed(page, baseURL!);
  await page.route("**/api/me/pinned-projects", (route) => route.fulfill({ status: 503, json: { error: "Try later" } }));
  await page.goto("/projects");
  const nav = pinnedRegion(page);
  await expect(nav.getByRole("alert")).toContainText("Could not load pinned projects");
  await page.unroute("**/api/me/pinned-projects");
  await nav.getByRole("button", { name: "Retry pinned projects", exact: true }).click();
  const button = page.locator(".project-card-wrapper").filter({ has: page.getByRole("heading", { name: project.name, exact: true }) }).getByRole("button");
  await expect(button).toBeEnabled();
  await page.route(`**/api/me/pinned-projects/${project.id}`, (route) => route.fulfill({ status: 503, json: { error: "Try later" } }));
  await button.click();
  await expect(page.locator('.snackbar [role="alert"]')).toContainText("Could not update pinned projects");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toBeEnabled();
  await page.unroute(`**/api/me/pinned-projects/${project.id}`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
});

test("sidebar drag pins, inserts, reorders both ways, persists and unpins", async ({ page, baseURL }) => {
  const a = (await seed(page, baseURL!, "Alpha")).project;
  const b = (await seed(page, baseURL!, "Beta")).project;
  const c = (await seed(page, baseURL!, "Gamma")).project;
  await page.goto("/projects");
  const pins = pinnedRegion(page);
  const others = otherRegion(page);
  await expect(pins).toContainText("Drag projects here");
  await row(others, a).dragTo(pins, { targetPosition: { x: 70, y: 10 } });
  await expectOrder(pins, [a]);
  await row(others, b).dragTo(row(pins, a), { targetPosition: { x: 70, y: 5 } });
  await expectOrder(pins, [b, a]);
  await row(others, c).dragTo(row(pins, b), { targetPosition: { x: 70, y: 5 } });
  await expectOrder(pins, [c, b, a]);
  await row(pins, a).dragTo(row(pins, c), { targetPosition: { x: 70, y: 5 } });
  await expectOrder(pins, [a, c, b]);
  const lastBox = await row(pins, b).boundingBox();
  await row(pins, a).dragTo(row(pins, b), { targetPosition: { x: 70, y: lastBox!.height - 5 } });
  await expectOrder(pins, [c, b, a]);
  await expect(page).toHaveURL("/projects");
  await page.reload();
  await expectOrder(pins, [c, b, a]);
  await row(pins, c).dragTo(others.locator(".nav-label"));
  await expectOrder(pins, [b, a]);
  await expect(row(others, c)).toBeVisible();
  expect((await (await page.request.get("/api/me/pinned-projects")).json()).projectIds).toEqual([b.id, a.id]);
});

test("failed reorders leave the prior order and unrelated drops do not pin", async ({ page, baseURL }) => {
  const a = (await seed(page, baseURL!, "Alpha")).project;
  const b = (await seed(page, baseURL!, "Beta")).project;
  await pin(page, baseURL!, a);
  await pin(page, baseURL!, b);
  await page.goto("/projects");
  const pins = pinnedRegion(page);
  await expectOrder(pins, [a, b]);
  const externalDrag = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData("text/plain", "not-a-project"); return data; });
  await pins.dispatchEvent("drop", { dataTransfer: externalDrag });
  await expectOrder(pins, [a, b]);
  await page.route(`**/api/me/pinned-projects/${b.id}`, (route) => route.fulfill({ status: 503, json: { error: "Try later" } }));
  await row(pins, b).dragTo(row(pins, a), { targetPosition: { x: 70, y: 5 } });
  await expect(page.locator('.snackbar [role="alert"]')).toContainText("Could not update pinned projects");
  await expectOrder(pins, [a, b]);
  await expect(row(pins, b).getByRole("button")).toBeEnabled();
  await page.reload();
  await expectOrder(pins, [a, b]);
});

for (const width of [1440, 390]) {
  test(`reorder buttons work without dragging at ${width}px`, async ({ page, baseURL }) => {
    const a = (await seed(page, baseURL!, "Alpha")).project;
    const b = (await seed(page, baseURL!, "Beta")).project;
    await pin(page, baseURL!, a);
    await pin(page, baseURL!, b);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects");
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    const pins = pinnedRegion(page);
    await expectOrder(pins, [a, b]);
    const trigger = pins.getByRole("button", { name: "Reorder pinned projects" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Reorder pinned projects" });
    await expect(dialog).toBeVisible();
    const up = dialog.getByRole("button", { name: `Move ${b.name} up`, exact: true });
    await up.focus();
    await page.keyboard.press("Enter");
    await expectOrder(pins, [b, a]);
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: `Move ${b.name} down`, exact: true }).click();
    await expectOrder(pins, [a, b]);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.reload();
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    await expectOrder(pins, [a, b]);
  });
}

test("unpinned sidebar follows latest issue update, including an in-app edit, while pins stay fixed", async ({ page, baseURL }) => {
  const { project: a, headers } = await seed(page, baseURL!, "Alpha");
  const { issue } = await (await page.request.post(`/api/projects/${a.slug}/issues`, { headers, data: { body: "Old project activity" } })).json();
  const b = (await seed(page, baseURL!, "Beta")).project;
  await page.request.post(`/api/projects/${b.slug}/issues`, { headers, data: { body: "New project activity" } });
  const c = (await seed(page, baseURL!, "Pinned")).project;
  await pin(page, baseURL!, c);
  await page.goto(`/issues/${issue.id}`);
  const others = otherRegion(page);
  await expect(others.getByRole("link").first()).toHaveText(b.name);
  await page.locator(".detail-form").getByRole("button", { name: "Markdown", exact: true }).click();
  await page.locator(".detail-form").getByLabel("Markdown source").fill("Updated project activity");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(others.getByRole("link").first()).toHaveText(a.name);
  await expectOrder(pinnedRegion(page), [c]);
  await page.reload();
  await expect(others.getByRole("link").first()).toHaveText(a.name);
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
