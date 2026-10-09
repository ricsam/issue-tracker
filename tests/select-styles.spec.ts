import { randomUUID } from "node:crypto";
import { test, expect, type Locator } from "@playwright/test";

async function expectChevron(select: Locator, compact = false) {
  await expect(select).toBeVisible();
  await expect(select).toHaveCSS("appearance", "none");
  await expect(select).toHaveCSS("background-image", /data:image\/svg\+xml/);
  await expect(select).toHaveCSS("background-repeat", "no-repeat");
  await expect(select).toHaveCSS("background-position-y", "50%");
  await expect(select).toHaveCSS(
    "background-position-x",
    `calc(100% - ${compact ? 8 : 12}px)`,
  );
  await expect(select).toHaveCSS("background-size", compact ? "12px 12px" : "14px 14px");
  // Leave a gap between the longest label and the inset indicator.
  await expect(select).toHaveCSS("padding-right", compact ? "28px" : "36px");
}

for (const width of [1440, 390]) {
  test(`select chevrons stay centered and inset at ${width}px`, async ({ page, baseURL }, testInfo) => {
    const headers = { Origin: baseURL! };
    const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
    const auth = await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
      headers,
      data: {
        ...(setupRequired ? { name: "Alex Morgan" } : {}),
        email: "alex@example.test",
        password: "local-browser-test-password",
      },
    });
    expect(auth.ok()).toBeTruthy();
    const projectResponse = await page.request.post("/api/projects", {
      headers,
      data: { name: `Select spacing ${randomUUID()}` },
    });
    expect(projectResponse.ok()).toBeTruthy();
    const { project } = await projectResponse.json();
    const issueResponse = await page.request.post(`/api/projects/${project.slug}/issues`, {
      headers,
      data: { body: "Check select spacing" },
    });
    expect(issueResponse.ok()).toBeTruthy();
    const { issue } = await issueResponse.json();

    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${project.slug}/board`);
    await page.getByRole("button", { name: "Add issues", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add issues to board" });
    const lane = dialog.getByLabel("Lane", { exact: true });
    await expectChevron(lane);
    await lane.selectOption("in_progress");
    await expect(lane).toHaveValue("in_progress");
    await lane.screenshot({ path: testInfo.outputPath("regular-select.png") });
    await dialog.getByRole("checkbox", { name: new RegExp(`Add issue !${issue.number}:`) }).check();
    await dialog.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator(".board-card select")).toHaveCount(0);
    await page.getByRole("button", { name: `Board actions for issue !${issue.number}` }).click();
    const menu = page.getByRole("menu", { name: `Board actions for issue !${issue.number}` });
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await menu.screenshot({ path: testInfo.outputPath("board-actions.png") });
    await menu.getByRole("menuitem", { name: "Done", exact: true }).click();
    await expect(page.locator(".board-column").filter({ has: page.getByRole("heading", { name: /^Done/ }) }).locator(".board-card")).toHaveCount(1);

    await page.goto(`/projects/${project.slug}`);
    await page.getByRole("button", { name: "Tagged users filters", exact: true }).click();
    const tagged = page.getByRole("combobox", { name: "Filter by tagged user", exact: true });
    await expectChevron(tagged);
    await tagged.focus();
    await expect(tagged).toBeFocused();
    await expect(tagged).toHaveCSS("border-color", "rgb(138, 106, 225)");
    await tagged.screenshot({ path: testInfo.outputPath("tagged-user-filter.png") });

    await page.emulateMedia({ forcedColors: "active" });
    await expect(tagged).toHaveCSS("appearance", "auto");
    await expect(tagged).toHaveCSS("background-image", "none");
    await page.goto(`/issues/${issue.id}`);
    await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toHaveCount(0);
  });
}
