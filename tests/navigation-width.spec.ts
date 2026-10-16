import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const storageKey = "issue-tracker:navigation-width";
let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  expect((await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(session.cookies);
  await page.setViewportSize({ width: 1440, height: 900 });
});

const resizer = (page: Page) => page.getByRole("separator", { name: "Resize navigation sidebar" });
async function expectWidth(page: Page, width: number) {
  await expect(resizer(page)).toHaveAttribute("aria-valuenow", String(width));
  await expect(page.locator("#workspace-navigation")).toHaveCSS("width", `${width}px`);
  await expect(page.locator(".main-shell")).toHaveCSS("margin-left", `${width}px`);
  expect((await page.locator(".main-shell").boundingBox())!.x).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}
async function dragBy(page: Page, delta: number) {
  const box = (await resizer(page).boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 150);
  await page.mouse.down();
  await expect(page.locator(".app-shell")).toHaveClass(/is-resizing-navigation/);
  await page.mouse.move(Math.max(0, x + delta), box.y + 150, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-resizing-navigation/);
}

test("navigation drag resizes the layout and persists across routes and reloads", async ({ page }) => {
  await page.goto("/w/default/projects");
  await expectWidth(page, 240);
  await dragBy(page, 120);
  await expectWidth(page, 360);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("360");
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "All issues", exact: true }).click();
  await expect(page).toHaveURL("/w/default/issues");
  await expectWidth(page, 360);
  await page.reload();
  await expectWidth(page, 360);
  await page.screenshot({ path: "test-results/resizable-navigation.png" });
  // Pointer capture keeps the drag active beyond the narrow resize handle.
  await dragBy(page, 800);
  await expectWidth(page, 480);
  await dragBy(page, -800);
  await expectWidth(page, 210);
});

test("navigation supports keyboard resizing and double-click reset", async ({ page }) => {
  await page.goto("/w/default/projects");
  await expect(resizer(page)).toHaveAttribute("aria-controls", "workspace-navigation");
  await expect(resizer(page)).toHaveAttribute("aria-orientation", "vertical");
  await resizer(page).focus();
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 250);
  await page.keyboard.press("Shift+ArrowRight");
  await expectWidth(page, 300);
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, 290);
  await page.keyboard.press("Home");
  await expectWidth(page, 210);
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, 210);
  await page.keyboard.press("End");
  await expectWidth(page, 480);
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 480);
  await resizer(page).dblclick();
  await expectWidth(page, 240);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await page.reload();
  await expectWidth(page, 240);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expectWidth(page, 210);
});

test("narrow viewports clamp without losing the saved width and keep the mobile drawer unchanged", async ({ page }) => {
  await page.goto("/w/default/projects");
  await resizer(page).focus();
  await page.keyboard.press("End");
  await expectWidth(page, 480);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expectWidth(page, 284);
  await expect(resizer(page)).toHaveAttribute("aria-valuemax", "284");
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("480");
  await page.reload();
  await expectWidth(page, 284);
  // Below the issue split-view breakpoint, a single content pane needs less room.
  await page.setViewportSize({ width: 800, height: 900 });
  await expectWidth(page, 280);
  await dragBy(page, -50);
  await expectWidth(page, 230);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Viewport emulation resolves before React handles the resize event. Wait for
  // the expanded bounds before End uses them, rather than the previous 280px cap.
  await expect(resizer(page)).toHaveAttribute("aria-valuemax", "480");
  await resizer(page).press("End");
  await expectWidth(page, 480);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(resizer(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator("#workspace-navigation")).toHaveClass(/is-open/);
  await expect(page.locator("#workspace-navigation")).toHaveCSS("width", "260px");
  await expect(page.locator(".main-shell")).toHaveCSS("margin-left", "0px");
  await page.locator("#workspace-navigation").getByRole("link", { name: "All issues", exact: true }).click();
  await expect(page.locator("#workspace-navigation")).not.toHaveClass(/is-open/);
  await page.reload();
  await expect(resizer(page)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("480");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectWidth(page, 480);
});

test("invalid widths and unavailable localStorage do not break navigation resizing", async ({ page }) => {
  await page.goto("/w/default/projects");
  for (const value of ["not-a-width", "Infinity", "", "-10", "209", "481"]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value });
    await page.reload();
    await expectWidth(page, 240);
  }
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage unavailable"); } });
  });
  await page.reload();
  await expectWidth(page, 240);
  await dragBy(page, 100);
  await expectWidth(page, 340);
  await resizer(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, 330);
  await resizer(page).dblclick();
  await expectWidth(page, 240);
});

test("resizing navigation leaves issue details and the collection usable", async ({ page, baseURL }) => {
  const created = await page.request.post("/api/issues", {
    headers: { Origin: baseURL! }, data: { body: "Navigation resize integration" },
  });
  expect(created.ok()).toBeTruthy();
  const { issue } = await created.json();
  await page.goto("/w/default/issues");
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill("Navigation resize integration");
  await page.locator(`.issue-link[href="/w/default/issues/${issue.number}"]`).click();
  const details = page.getByRole("complementary", { name: "Issue details", exact: true });
  await expect(details).toBeVisible();
  await dragBy(page, 240);
  await expectWidth(page, 480);
  await expect(details.locator(".detail-form .editor-preview")).toContainText("Navigation resize integration");
  await page.setViewportSize({ width: 1024, height: 900 });
  await expectWidth(page, 284);
  const collectionBox = (await page.locator(".project-issues-content").boundingBox())!;
  const detailBox = (await details.boundingBox())!;
  expect(collectionBox.width).toBeGreaterThanOrEqual(320);
  expect(detailBox.width).toBeGreaterThanOrEqual(420);
  expect(collectionBox.x + collectionBox.width).toBeLessThanOrEqual(detailBox.x);
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(1024);
  await page.getByRole("textbox", { name: "Search issues", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search issues", exact: true })).toBeFocused();
});
