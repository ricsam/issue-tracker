import { randomUUID } from "node:crypto";
import { test, expect, webkit, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers, data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Touch ${randomUUID()}` } })).json();
  for (let i = 0; i < 25; i++) {
    expect((await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `Touch task ${i}`, labels: ["navigation"] } })).ok()).toBeTruthy();
  }
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator(".issue-row")).toHaveCount(25);
  return project.slug as string;
}

// Native browser input, not dispatched DOM events or assigning scrollLeft.
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12, id: 1 }] });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: mobile table leaves Board icon and issue taps distinct`, async ({ browser, baseURL }) => {
    // CI installs Chromium only; enable this additional engine after running
    // `bunx playwright install --with-deps webkit`.
    test.skip(engine === "webkit" && process.env.E2E_WEBKIT !== "1", "Set E2E_WEBKIT=1 to also exercise WebKit");
    const ownBrowser = engine === "webkit" ? await webkit.launch() : null;
    const context = await (ownBrowser || browser).newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const slug = await seed(page, baseURL!);
      // A title link must never create an out-of-row hit target on touch layouts,
      // including wide tablets where the desktop split-view breakpoint matches.
      const title = page.locator(".issue-row .issue-link").first();
      await expect.poll(() => title.evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
      await page.setViewportSize({ width: 1100, height: 844 });
      await expect.poll(() => title.evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
      await page.setViewportSize({ width: 390, height: 844 });
      const board = page.getByRole("link", { name: "Board", exact: true });
      const icon = board.locator("svg");
      await icon.tap();
      await expect(page).toHaveURL(new RegExp(`/projects/${slug}/board$`));
      await page.getByRole("link", { name: "List", exact: true }).tap();
      await expect(page).toHaveURL(new RegExp(`/projects/${slug}$`));
      // Small phones must be able to configure columns using touch controls.
      await page.setViewportSize({ width: 320, height: 640 });
      await page.getByRole("button", { name: "Columns", exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: "Table columns", exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      await dialog.getByRole("checkbox", { name: "Show Created column", exact: true }).tap();
      await dialog.getByRole("button", { name: "Move Created column up", exact: true }).tap();
      await dialog.getByRole("button", { name: "Save columns", exact: true }).tap();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Sort by created", exact: true })).toHaveCount(0);
      const issue = page.locator(".issue-row .issue-link").first();
      const href = await issue.getAttribute("href");
      await issue.tap();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
    } finally {
      await context.close();
      await ownBrowser?.close();
    }
  });
}

test("touch swipes pan across columns and vertically over rows without opening issues", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const slug = await seed(page, baseURL!);
    const scroll = page.getByRole("region", { name: "Scrollable issues table" });
    await page.locator(".issue-row").first().scrollIntoViewIfNeeded();
    const row = (await page.locator(".issue-row").first().boundingBox())!;
    const y = Math.max(150, row.y + row.height / 2);
    await swipe(page, { x: 340, y }, { x: 65, y });
    await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(150);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await scroll.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft <= 2)) break;
      await swipe(page, { x: 340, y }, { x: 65, y });
    }
    await expect.poll(() => scroll.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft)).toBeLessThanOrEqual(2);
    await expect(page.locator(".issue-row").first().locator("time")).toBeInViewport();
    const before = await page.locator(".issue-row").first().evaluate((el) => el.getBoundingClientRect().top);
    await swipe(page, { x: 220, y: 680 }, { x: 220, y: 260 });
    await expect.poll(() => page.locator(".issue-row").first().evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(before - 150);
    const lastRow = page.locator(".issue-row").last();
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await lastRow.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)) break;
      await swipe(page, { x: 220, y: 680 }, { x: 220, y: 260 });
    }
    await expect.poll(() => lastRow.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(845);
    await expect(page).toHaveURL(new RegExp(`/projects/${slug}$`));
  } finally { await context.close(); }
});

test("desktop metadata still opens its own row through the full-row link", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seed(page, baseURL!);
  const row = page.locator(".issue-row").nth(2);
  const link = row.locator(".issue-link");
  await expect.poll(() => link.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('\"\"');
  const cell = row.locator("td").last();
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(link).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("complementary", { name: "Issue details", exact: true })).toContainText("Touch task 2");
});
