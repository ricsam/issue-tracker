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
    await dialog.getByRole("checkbox", { name: /Add issue #1:/ }).check();
    await dialog.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(dialog).toBeHidden();

    const compact = page.getByRole("combobox", { name: /Lane for issue/ });
    await expectChevron(compact, true);
    await expect(compact).toHaveValue("in_progress");
    await compact.screenshot({ path: testInfo.outputPath("compact-select.png") });
    await compact.selectOption("done");
    await expect(compact).toHaveValue("done");
    await expect(page.locator(".board-column").filter({ has: compact })).toContainText("Done");

    await page.goto(`/issues/${issue.id}`);
    const assignee = page.getByRole("combobox", { name: "Assignee", exact: true });
    await expectChevron(assignee);
    await assignee.focus();
    await expect(assignee).toBeFocused();
    await expect(assignee).toHaveCSS("border-color", "rgb(138, 106, 225)");
    await assignee.screenshot({ path: testInfo.outputPath("property-select.png") });

    await page.emulateMedia({ forcedColors: "active" });
    await expect(assignee).toHaveCSS("appearance", "auto");
    await expect(assignee).toHaveCSS("background-image", "none");
  });
}
