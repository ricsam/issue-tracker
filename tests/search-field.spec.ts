import { randomUUID } from "node:crypto";
import { test, expect, type Locator } from "@playwright/test";

async function expectSearchLayout(field: Locator) {
  const input = field.getByRole("textbox");
  const icon = field.locator("svg");
  await expect(input).toBeVisible();
  await expect(icon).toBeVisible();
  const inputBox = (await input.boundingBox())!;
  const iconBox = (await icon.boundingBox())!;
  const textInset = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  });
  expect(inputBox.x + textInset - (iconBox.x + iconBox.width)).toBeGreaterThanOrEqual(6);
  expect(Math.abs(iconBox.y + iconBox.height / 2 - (inputBox.y + inputBox.height / 2))).toBeLessThanOrEqual(1);

  // Clicking the decorative icon should focus the input underneath it.
  const fieldBox = (await field.boundingBox())!;
  await field.click({ position: {
    x: iconBox.x + iconBox.width / 2 - fieldBox.x,
    y: iconBox.y + iconBox.height / 2 - fieldBox.y,
  } });
  await expect(input).toBeFocused();
  await input.fill("Search spacing");
  await expect(input).toHaveValue("Search spacing");
  await input.fill("");
}

for (const width of [1440, 390]) {
  test(`search icons stay clear of text and centered at ${width}px`, async ({ page, baseURL }, testInfo) => {
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
    const response = await page.request.post("/api/projects", {
      headers, data: { name: `Search spacing ${randomUUID()}` },
    });
    expect(response.ok()).toBeTruthy();
    const { project } = await response.json();
    await page.setViewportSize({ width, height: 900 });

    for (const [view, path] of [
      ["all-issues", "/issues"],
      ["project-list", `/projects/${project.slug}`],
      ["project-board", `/projects/${project.slug}/board`],
    ]) {
      await page.goto(path!);
      const field = page.locator(".filter-bar .search-field");
      await expectSearchLayout(field);
      await field.screenshot({ path: testInfo.outputPath(`${view}-search.png`) });
    }

    await page.getByRole("button", { name: "Add issues", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add issues to board" });
    const field = dialog.locator(".search-field");
    await expectSearchLayout(field);
    await field.screenshot({ path: testInfo.outputPath("add-issues-search.png") });
  });
}
