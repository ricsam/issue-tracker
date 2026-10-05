import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";

test("issues are label-only; boards explicitly place, move and remove work in lanes", async ({
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
  const { project } = await (
    await page.request.post("/api/projects", {
      headers,
      data: { name: "Board work" },
    })
  ).json();
  const projectPath = `/projects/${project.slug}`;
  const endpoint = `/api/projects/${project.slug}/board`;
  const issueEndpoint = `/api/projects/${project.slug}/issues`;
  for (const body of [
    "# Plan the release\n\nKeep all details here.",
    "Review the design",
    "Publish the site",
  ]) {
    const response = await page.request.post(issueEndpoint, {
      headers,
      data: { body, labels: ["release"] },
    });
    expect(response.ok()).toBeTruthy();
    const { issue } = await response.json();
    expect(issue).not.toHaveProperty("status");
    expect(issue).not.toHaveProperty("priority");
    expect(issue).not.toHaveProperty("lane");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath + "/board");
  await expect(page.getByLabel("Filter by lane")).toHaveCount(0);
  await expect(page.locator(".board-column")).toHaveCount(3);
  await expect(page.locator(".board-card")).toHaveCount(0);
  await expect(page.getByText(/No work on the board yet/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Backlog/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add issues to board" });
  const addButton = add.getByRole("button", {
    name: "Add to board",
    exact: true,
  });
  await expect(addButton).toBeDisabled();
  await add.getByRole("checkbox", { name: /Add issue #1:/ }).check();
  await add.getByLabel("Search issues to add to board").fill("Review");
  await expect(add.getByRole("checkbox")).toHaveCount(1);
  await add.getByRole("checkbox", { name: /Add issue #2:/ }).check();
  await add.getByLabel("Search issues to add to board").fill("");
  await expect(
    add.getByRole("checkbox", { name: /Add issue #1:/ }),
  ).toBeChecked();
  await add.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await add.getByLabel("Search issues to add to board").fill("release");
  await add.getByRole("button", { name: "Select matching" }).click();
  await add.getByRole("checkbox", { name: /Add issue #3:/ }).uncheck();
  await add.getByLabel("Lane", { exact: true }).selectOption("todo");
  await page.route(`**${endpoint}/issues`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test add failed" }),
    });
  });
  await addButton.click();
  await expect(add.getByRole("alert")).toHaveText("Test add failed");
  await expect(
    add.getByRole("checkbox", { name: /Add issue #1:/ }),
  ).toBeChecked();
  await page.unroute(`**${endpoint}/issues`);
  await addButton.click();
  await expect(add).toBeHidden();
  await expect(page.locator(".board-card")).toHaveCount(2);
  const todo = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Todo/ }) });
  const progress = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^In progress/ }) });
  const done = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Done/ }) });
  await expect(todo.locator(".board-card")).toHaveCount(2);
  const plan = page
    .locator(".board-card")
    .filter({ hasText: "Plan the release" });
  await plan.dragTo(progress);
  await expect(progress.locator(".board-card")).toHaveCount(1);
  await plan
    .getByRole("combobox", { name: /Lane for issue/ })
    .selectOption("done");
  await expect(done.locator(".board-card")).toHaveCount(1);
  await page.reload();
  await expect(done.locator(".board-card")).toHaveCount(1);
  await expect(todo.locator(".board-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await expect(add.getByRole("checkbox")).toHaveCount(1);
  await expect(
    add.getByRole("checkbox", { name: /Add issue #3:/ }),
  ).toBeVisible();
  await add.getByRole("button", { name: "Cancel", exact: true }).click();

  // Removing lanes changes visibility, never membership or issue data.
  await page.getByRole("button", { name: "Manage lanes" }).click();
  const settings = page.getByRole("dialog", { name: "Manage lanes" });
  const save = settings.getByRole("button", {
    name: "Save board",
    exact: true,
  });
  await expect(settings.locator(".lane-management-row")).toHaveCount(3);
  await settings.getByRole("button", { name: "Remove Done lane", exact: true }).click();
  await settings.getByRole("button", { name: "Remove In progress lane", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Remove Todo lane", exact: true })).toBeDisabled();
  await expect(settings.getByText(/Keep at least one lane/)).toBeVisible();
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Test save failed" }),
      });
    } else await route.continue();
  });
  await save.click();
  await expect(settings.getByRole("alert")).toHaveText("Test save failed");
  await page.unroute(`**${endpoint}`);
  await save.click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".board-column")).toHaveCount(1);
  await expect(page.locator(".board-card")).toHaveCount(1);
  await expect(page.locator(".board-summary")).toContainText(
    "1 issues in hidden lanes",
  );
  await page.reload();
  await expect(page.locator(".board-column")).toHaveCount(1);
  const savedSettings = (await (await page.request.get(endpoint)).json()).board;
  expect(savedSettings.lanes).toEqual(["todo"]);
  expect(savedSettings.cards).toHaveLength(2);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await expect(
    add.getByLabel("Lane", { exact: true }).locator("option"),
  ).toHaveCount(1);
  await add.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Add Done lane", exact: true }).click();
  await save.click();
  await expect(page.locator(".board-card")).toHaveCount(2);

  // All issues remain in the list, with no global status or priority controls.
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  await expect(page.locator(".issue-row select")).toHaveCount(0);
  await expect(page.getByLabel("Filter by lane")).toHaveCount(0);
  await expect(page.getByLabel("Filter by status")).toHaveCount(0);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create issue" });
  const editor = create.getByRole("textbox", { name: "Issue", exact: true });
  await expect(editor).toBeFocused();
  await expect(create.getByRole("combobox")).toHaveCount(0);
  await expect(
    create.getByRole("checkbox", { name: "Add to board", exact: true }),
  ).toHaveCount(0);
  await expect(create.getByLabel("Issue title", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    create.getByRole("button", { name: "Create issue", exact: true }),
  ).toBeDisabled();
  expect((await create.boundingBox())!.width).toBe(960);
  expect((await editor.boundingBox())!.height).toBeGreaterThanOrEqual(260);
  await editor.fill("Ship a simpler issue editor");
  await create.getByLabel("Labels", { exact: true }).fill("design, idea");
  await page.screenshot({ path: "test-results/create-issue-desktop.png" });
  await create
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/issues\//);
  const issueUrl = page.url();
  await expect(page.getByLabel("Labels", { exact: true })).toHaveValue(
    "design, idea",
  );
  await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Priority", { exact: true })).toHaveCount(0);
  await page.goto(projectPath + "/board");
  await expect(page.locator(".board-card")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: /Ship a simpler issue editor/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await add.getByRole("checkbox", { name: /Add issue #4:/ }).check();
  await addButton.click();
  await expect(page.locator(".board-card")).toHaveCount(3);

  // Updating an issue body cannot overwrite its lane.
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
    todo.getByRole("link", { name: /A clearer issue/ }),
  ).toBeVisible();

  // Remove only the board placement; re-adding chooses a fresh lane.
  await plan
    .getByRole("button", { name: "Remove issue #1 from board" })
    .click();
  await expect(page.locator(".board-card")).toHaveCount(2);
  await page.getByRole("link", { name: "List", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: /Plan the release/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await add.getByRole("checkbox", { name: /Add issue #1:/ }).check();
  await addButton.click();
  await expect(
    todo.getByRole("link", { name: /Plan the release/ }),
  ).toBeVisible();

  // Creation stays outside the board on mobile too, and dialogs fit the screen.
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
  await page.screenshot({ path: "test-results/create-issue-mobile.png" });
  await create
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/issues\//);
  await page.goto(projectPath + "/board");
  await expect(page.locator(".board-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  expect(
    await add.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy();
  await add.getByRole("checkbox", { name: /Add issue #5:/ }).check();
  await add.getByLabel("Lane", { exact: true }).selectOption("done");
  await page.screenshot({ path: "test-results/board-add-mobile.png" });
  await addButton.click();
  await expect(
    done.getByRole("link", { name: /Keep this in the list only/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage lanes" }).click();
  expect(
    await settings.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "test-results/board-settings-mobile.png" });
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(4);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/configured-board-desktop.png",
    fullPage: true,
  });

  // Custom lanes can be created, used, removed, restored, and survive reloads.
  await page.getByRole("button", { name: "Manage lanes" }).click();
  const name = settings.getByLabel("Create a new lane");
  const createLane = settings.getByRole("button", { name: "Create lane", exact: true });
  await expect(createLane).toBeDisabled();
  await name.fill("  TODO  ");
  await expect(createLane).toBeDisabled();
  await expect(settings.getByRole("alert")).toContainText("already exists");
  await name.fill("Discarded lane");
  await createLane.click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Discarded lane/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await name.fill("  In review  ");
  await name.press("Enter");
  await expect(settings.locator(".lane-management-row").filter({ hasText: "In review" })).toBeVisible();
  await save.click();
  // Extra lanes stay readable in a horizontally scrolling desktop board.
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Add In progress lane", exact: true }).click();
  const longName = "Long".repeat(15);
  await name.fill(longName);
  await createLane.click();
  await save.click();
  await expect(page.locator(".board-column")).toHaveCount(5);
  expect(await page.locator(".board").evaluate((element) => element.scrollWidth > element.clientWidth)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Manage lanes" }).click();
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await settings.getByRole("button", { name: `Remove ${longName} lane`, exact: true }).click();
  await settings.getByRole("button", { name: "Remove In progress lane", exact: true }).click();
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await save.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const review = page.locator(".board-column").filter({ has: page.getByRole("heading", { name: /^In review/ }) });
  await expect(review).toBeVisible();
  const customBoard = (await (await page.request.get(endpoint)).json()).board;
  const customId = customBoard.customLanes.find((lane: { label: string }) => lane.label === "In review").value;
  await plan.getByRole("combobox", { name: /Lane for issue/ }).selectOption(customId);
  await expect(review.locator(".board-card")).toHaveCount(1);
  await page.reload();
  await expect(review.locator(".board-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Remove In review lane", exact: true }).click();
  await save.click();
  await expect(review).toHaveCount(0);
  await expect(page.locator(".board-summary")).toContainText("1 issues in hidden lanes");
  await page.reload();
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Add In review lane", exact: true }).click();
  await save.click();
  await expect(review.locator(".board-card")).toHaveCount(1);
  // New work can be placed directly into custom lanes, including from mobile.
  await page.request.post(issueEndpoint, { headers, data: { body: "Check custom lane" } });
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await add.getByRole("checkbox", { name: /Check custom lane/ }).check();
  await add.getByLabel("Lane", { exact: true }).selectOption(customId);
  await addButton.click();
  await expect(review.locator(".board-card")).toHaveCount(2);
  await review.getByRole("button", { name: "Remove issue #6 from board" }).click();
  await expect(review.locator(".board-card")).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await plan.dragTo(todo);
  await expect(todo.getByRole("link", { name: /Plan the release/ })).toBeVisible();
  await plan.dragTo(review);
  await expect(review.locator(".board-card")).toHaveCount(1);
  await page.screenshot({ path: "test-results/custom-lanes-desktop.png", fullPage: true });

  // New issues and other projects never become work automatically.
  expect(
    (
      await page.request.post(issueEndpoint, {
        headers,
        data: { body: "Future idea" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(4);
  const other = await (
    await page.request.post("/api/projects", {
      headers,
      data: { name: "Other board" },
    })
  ).json();
  await page.goto(`/projects/${other.project.slug}/board`);
  await expect(page.locator(".board-column")).toHaveCount(3);
  await expect(page.locator(".board-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  await expect(add.getByRole("checkbox")).toHaveCount(0);
  await expect(add.getByText(/No issues yet/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("lanes reorder by dragging their headings or from Manage lanes, and the order is shared", async ({
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
  const { project } = await (
    await page.request.post("/api/projects", {
      headers,
      data: { name: "Lane order" },
    })
  ).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  const review = { value: `custom_${randomUUID()}`, label: "In review" };
  expect(
    (
      await page.request.patch(endpoint, {
        headers,
        data: {
          lanes: ["todo", "in_progress", "done", review.value],
          customLanes: [review],
        },
      })
    ).ok(),
  ).toBeTruthy();
  for (const [body, lane] of [
    ["Draft the plan", "todo"],
    ["Ship the release", "done"],
  ]) {
    const { issue } = await (
      await page.request.post(`/api/projects/${project.slug}/issues`, {
        headers,
        data: { body },
      })
    ).json();
    expect(
      (
        await page.request.post(`${endpoint}/issues`, {
          headers,
          data: { issueIds: [issue.id], lane },
        })
      ).ok(),
    ).toBeTruthy();
  }
  const savedLanes = async () =>
    (await (await page.request.get(endpoint)).json()).board.lanes;
  const names = page.locator(".board-column h2 .lane-name");
  const heading = (name: string) =>
    page.getByRole("heading", { name: new RegExp(`^${name}\\s*\\d+$`) });
  const column = (name: string) =>
    page.locator(".board-column").filter({ has: heading(name) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.slug}/board`);
  await expect(names).toHaveText(["Todo", "In progress", "Done", "In review"]);

  // Dropping a lane on another puts it in that lane's place; cards travel with it.
  await heading("Done").dragTo(column("Todo"));
  await expect(names).toHaveText(["Done", "Todo", "In progress", "In review"]);
  await heading("Todo").dragTo(column("In review"));
  await expect(names).toHaveText(["Done", "In progress", "In review", "Todo"]);
  await expect(column("Done").getByRole("link", { name: /Ship the release/ })).toBeVisible();
  await expect(column("Todo").getByRole("link", { name: /Draft the plan/ })).toBeVisible();
  expect(await savedLanes()).toEqual(["done", "in_progress", review.value, "todo"]);
  await page.reload();
  await expect(names).toHaveText(["Done", "In progress", "In review", "Todo"]);
  await expect(
    page.getByRole("combobox", { name: /Lane for issue #1/ }).locator("option"),
  ).toHaveText(["Done", "In progress", "In review", "Todo"]);

  // While dragging, the lane is dimmed and its destination edge is marked.
  await dragHeadingOver(page, heading("In review"), column("In progress"));
  await expect(column("In review")).toHaveClass(/is-lane-dragging/);
  await expect(column("In progress")).toHaveClass(/lane-drop-before/);
  await page.screenshot({ path: "test-results/lane-drag-desktop.png" });
  await dragHeadingOver(page, null, column("Todo"));
  await expect(column("Todo")).toHaveClass(/lane-drop-after/);
  await expect(column("In progress")).not.toHaveClass(/lane-drop/);
  await page.mouse.up();
  await expect(names).toHaveText(["Done", "In progress", "Todo", "In review"]);
  await expect(page.locator(".is-lane-dragging, [class*=lane-drop]")).toHaveCount(0);

  // A failed save restores the previous order and explains why.
  await page.route(`**${endpoint}/lanes/**`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test lane move failed" }),
    }),
  );
  await heading("In review").dragTo(column("Done"));
  await expect(page.getByRole("alert")).toHaveText("Test lane move failed");
  await expect(names).toHaveText(["Done", "In progress", "Todo", "In review"]);
  await page.unroute(`**${endpoint}/lanes/**`);
  expect(await savedLanes()).toEqual(["done", "in_progress", "todo", review.value]);

  // Manage lanes lists lanes in board order, with keyboard-friendly move buttons.
  await page.getByRole("button", { name: "Manage lanes" }).click();
  const settings = page.getByRole("dialog", { name: "Manage lanes" });
  const rows = settings.locator(".lane-management-row .lane-name");
  const save = settings.getByRole("button", { name: "Save board", exact: true });
  await expect(rows).toHaveText(["Done", "In progress", "Todo", "In review"]);
  await expect(settings.getByRole("listitem")).toHaveCount(4);
  await expect(settings.getByRole("button", { name: "Move Done lane up" })).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Move In review lane down" })).toBeDisabled();
  const todoUp = settings.getByRole("button", { name: "Move Todo lane up" });
  await todoUp.click();
  await expect(rows).toHaveText(["Done", "Todo", "In progress", "In review"]);
  await expect(todoUp).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveText(["Todo", "Done", "In progress", "In review"]);
  await expect(settings.getByRole("status")).toHaveText("Todo moved to position 1 of 4.");
  // At the top the button stays focused but unavailable, so repeats are no-ops.
  await expect(todoUp).toBeFocused();
  await expect(todoUp).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveText(["Todo", "Done", "In progress", "In review"]);
  // Moving a row down re-inserts its element; focus stays with it.
  const doneDown = settings.getByRole("button", { name: "Move Done lane down" });
  await doneDown.click();
  await expect(rows).toHaveText(["Todo", "In progress", "Done", "In review"]);
  await expect(doneDown).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(rows).toHaveText(["Todo", "In progress", "In review", "Done"]);
  await expect(doneDown).toBeFocused();
  await expect(doneDown).toBeDisabled();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(names).toHaveText(["Done", "In progress", "Todo", "In review"]);

  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Move Todo lane up" }).click();
  await settings.getByRole("button", { name: "Move Todo lane up" }).click();
  await settings.getByRole("button", { name: "Remove In progress lane", exact: true }).click();
  await expect(rows).toHaveText(["Todo", "Done", "In review"]);
  await save.click();
  await expect(settings).toBeHidden();
  await expect(names).toHaveText(["Todo", "Done", "In review"]);
  expect(await savedLanes()).toEqual(["todo", "done", review.value]);
  // Restored lanes join at the end, where they can be moved again.
  await page.getByRole("button", { name: "Manage lanes" }).click();
  await settings.getByRole("button", { name: "Add In progress lane", exact: true }).click();
  await expect(rows).toHaveText(["Todo", "Done", "In review", "In progress"]);
  await settings.getByRole("button", { name: "Move In progress lane up" }).click();
  await settings.getByRole("button", { name: "Move In progress lane up" }).click();
  await save.click();
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(names).toHaveText(["Todo", "In progress", "Done", "In review"]);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add issues to board" });
  const addLane = add.getByLabel("Lane", { exact: true });
  await expect(addLane).toHaveValue("todo");
  await expect(addLane.locator("option")).toHaveText(["Todo", "In progress", "Done", "In review"]);
  await add.getByRole("button", { name: "Cancel", exact: true }).click();

  // The move buttons fit on a phone, where lanes stack vertically.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Manage lanes" }).click();
  expect(
    await settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy();
  for (const row of await settings.locator(".lane-management-row").all()) {
    const box = (await row.boundingBox())!;
    expect(box.height).toBeLessThan(60);
  }
  await page.screenshot({ path: "test-results/lane-order-mobile.png" });
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/lane-order-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

// Hold a lane heading over a target without dropping it (null keeps dragging).
async function dragHeadingOver(
  page: Page,
  source: Locator | null,
  target: Locator,
) {
  if (source) {
    const from = (await source.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
  }
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 8 });
}
