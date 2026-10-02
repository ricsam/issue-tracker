import { test, expect } from "@playwright/test";

test("single-editor issues and saved board selection work on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const headers = { Origin: baseURL! };
  const { setupRequired } = await (
    await page.request.get("/api/auth/status")
  ).json();
  const auth = await page.request.post(
    setupRequired ? "/api/auth/setup" : "/api/auth/login",
    {
      headers,
      data: {
        ...(setupRequired ? { name: "Alex Morgan" } : {}),
        email: "alex@example.test",
        password: "local-browser-test-password",
      },
    },
  );
  expect(auth.ok()).toBeTruthy();
  const projectResponse = await page.request.post("/api/projects", {
    headers,
    data: { name: "Board selection" },
  });
  const { project } = await projectResponse.json();
  const projectPath = `/projects/${project.slug}`;
  const endpoint = `/api/projects/${project.slug}/board`;
  const issueEndpoint = `/api/projects/${project.slug}/issues`;
  for (const [body, status] of [
    ["# Plan the release\n\nKeep all details here.", "backlog"],
    ["Review the design", "todo"],
    ["# Publish the site", "done"],
  ]) {
    const result = await page.request.post(issueEndpoint, {
      headers,
      data: { body, status },
    });
    expect(result.ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath + "/board");
  await expect(page.locator(".board-column")).toHaveCount(4);
  await expect(page.locator(".board-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Configure board" }).click();
  const settings = page.getByRole("dialog", { name: "Configure board" });
  const save = settings.getByRole("button", {
    name: "Save board",
    exact: true,
  });
  await settings
    .getByRole("checkbox", { name: "Include all current and future issues" })
    .uncheck();
  await settings.getByRole("checkbox", { name: /Include issue #2:/ }).uncheck();
  await settings
    .getByRole("checkbox", { name: "In progress", exact: true })
    .uncheck();
  await settings.getByRole("checkbox", { name: "Done", exact: true }).uncheck();
  await settings.getByLabel("Search issues to add to board").fill("Publish");
  await expect(
    settings.getByRole("checkbox", { name: /Include issue/ }),
  ).toHaveCount(1);
  await expect(
    settings.getByRole("checkbox", { name: /Include issue #3:/ }),
  ).toBeChecked();
  await settings.getByLabel("Search issues to add to board").fill("");
  await expect(
    settings.getByRole("checkbox", { name: /Include issue #2:/ }),
  ).not.toBeChecked();
  await settings
    .getByRole("checkbox", { name: "Backlog", exact: true })
    .uncheck();
  await settings.getByRole("checkbox", { name: "Todo", exact: true }).uncheck();
  await expect(save).toBeDisabled();
  await expect(settings.getByRole("alert")).toContainText(
    "Select at least one lane",
  );
  await settings
    .getByRole("checkbox", { name: "Backlog", exact: true })
    .check();
  await settings.getByRole("checkbox", { name: "Todo", exact: true }).check();
  await save.click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".board-column")).toHaveCount(2);
  await expect(page.locator(".board-card")).toHaveCount(1);
  await expect(page.locator(".board-summary")).toContainText(
    "1 issues in hidden lanes",
  );
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(1);
  await expect(page.locator(".board-column")).toHaveCount(2);
  const savedSettings = (await (await page.request.get(endpoint)).json()).board;
  expect(savedSettings.lanes).toEqual(["backlog", "todo"]);
  expect(savedSettings.issueIds).toHaveLength(2);

  // Cancel and failed saves must not silently change the saved board.
  await page.getByRole("button", { name: "Configure board" }).click();
  await settings.getByRole("button", { name: "Clear selection" }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Configure board" }).click();
  await expect(
    settings.getByRole("checkbox", { name: /Include issue #1:/ }),
  ).toBeChecked();
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Test save failed" }),
      });
    } else await route.continue();
  });
  await settings.getByRole("checkbox", { name: /Include issue #2:/ }).check();
  await save.click();
  await expect(settings.getByRole("alert")).toHaveText("Test save failed");
  await expect(
    settings.getByRole("checkbox", { name: /Include issue #2:/ }),
  ).toBeChecked();
  await page.unroute(`**${endpoint}`);
  await save.click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".board-card")).toHaveCount(2);
  const todo = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Todo/ }) });
  await page
    .locator(".board-card")
    .filter({ hasText: "Plan the release" })
    .dragTo(todo);
  await expect(todo.locator(".board-card")).toHaveCount(2);

  // The full list is unaffected by board lanes or membership.
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create issue" });
  const editor = create.getByRole("textbox", { name: "Issue", exact: true });
  await expect(editor).toBeFocused();
  await expect(create.getByLabel("Issue title", { exact: true })).toHaveCount(
    0,
  );
  await expect(create.getByText("Description", { exact: true })).toHaveCount(0);
  await expect(
    create.getByRole("button", { name: "Create issue", exact: true }),
  ).toBeDisabled();
  const desktopBox = (await create.boundingBox())!;
  expect(desktopBox.width).toBe(960);
  expect((await editor.boundingBox())!.height).toBeGreaterThanOrEqual(260);
  await expect(
    create.getByRole("checkbox", { name: "Add to board", exact: true }),
  ).toBeChecked();
  await editor.fill("Ship a simpler issue editor");
  await page.screenshot({ path: "test-results/create-issue-desktop.png" });
  await create
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/issues\//);
  const issueUrl = page.url();
  await expect(
    page.getByRole("textbox", { name: "Issue", exact: true }),
  ).toContainText("Ship a simpler issue editor");
  await page.goto(projectPath + "/board");
  await expect(page.locator(".board-card")).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: /Ship a simpler issue editor/ }),
  ).toBeVisible();

  // Updating the single Markdown body updates the derived board title.
  await page.goto(issueUrl);
  await page
    .locator(".detail-form")
    .getByRole("button", { name: "Markdown", exact: true })
    .click();
  await page
    .locator(".detail-form")
    .getByLabel("Markdown source")
    .fill("# A **clearer** issue\n\nAll of the details stay here.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.goto(projectPath + "/board");
  await expect(
    page.getByRole("link", { name: /A clearer issue/ }),
  ).toBeVisible();

  // On mobile the modal stays within the viewport and still autofocuses on reopen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(editor).toBeFocused();
  const mobileBox = (await create.boundingBox())!;
  expect(mobileBox.x).toBeGreaterThanOrEqual(0);
  expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(390);
  expect(
    await create.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await editor.fill("Keep this in the list only");
  await create
    .getByRole("checkbox", { name: "Add to board", exact: true })
    .uncheck();
  await page.screenshot({ path: "test-results/create-issue-mobile.png" });
  await create
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/issues\//);
  await page.goto(projectPath + "/board");
  await expect(page.locator(".board-card")).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: /Keep this in the list only/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Configure board" }).click();
  await expect(settings).toBeVisible();
  expect(
    await settings.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "test-results/board-settings-mobile.png" });
  await settings.getByRole("button", { name: "Clear selection" }).click();
  await save.click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".board-card")).toHaveCount(0);
  await expect(page.getByText(/No issues selected/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/No issues selected/)).toBeVisible();
  await page.getByRole("button", { name: "Configure board" }).click();
  await settings
    .getByRole("checkbox", { name: "Include all current and future issues" })
    .check();
  await settings.getByRole("checkbox", { name: "Done", exact: true }).check();
  await save.click();
  await expect(page.locator(".board-card")).toHaveCount(5);
  expect(
    (
      await page.request.post(issueEndpoint, {
        headers,
        data: { body: "Future issues are included" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(6);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/configured-board-desktop.png",
    fullPage: true,
  });

  // Project board settings are isolated.
  const other = await (
    await page.request.post("/api/projects", {
      headers,
      data: { name: "Other board" },
    })
  ).json();
  await page.getByRole("link", { name: "All projects", exact: true }).click();
  await page.goto(`/projects/${other.project.slug}/board`);
  await expect(page.locator(".board-column")).toHaveCount(4);
  await page.getByRole("button", { name: "Configure board" }).click();
  await expect(
    settings.getByRole("checkbox", {
      name: "Include all current and future issues",
    }),
  ).toBeChecked();
  expect(errors).toEqual([]);
});
