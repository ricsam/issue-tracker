import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: baseURL };
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
  const response = await page.request.post("/api/projects", {
    headers,
    data: { name: `Sidebar ${randomUUID()}` },
  });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  const projectPath = `/projects/${project.slug}`;
  const issueIds: string[] = [];
  for (const title of ["Sidebar alpha", "Sidebar beta", "Other issue"]) {
    const created = await page.request.post(
      `${projectPath.replace("/projects", "/api/projects")}/issues`,
      {
        headers,
        data: { body: title },
      },
    );
    expect(created.ok()).toBeTruthy();
    issueIds.push((await created.json()).issue.id);
  }
  const placed = await page.request.post(
    `/api/projects/${project.slug}/board/issues`,
    {
      headers,
      data: { issueIds, lane: "todo" },
    },
  );
  expect(placed.ok()).toBeTruthy();
  return projectPath;
}

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Issue details", exact: true });
const issueEditor = (page: Page) =>
  sidebar(page).getByRole("textbox", { name: "Issue", exact: true });
const issueLink = (page: Page, title: string) =>
  page
    .locator(".project-issues-content .issue-link")
    .filter({ hasText: title });

async function assertLayout(page: Page, width: number) {
  await expect(sidebar(page)).toHaveClass(/issue-detail-sidebar/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
  const content = page.locator(".project-issues-content");
  await expect(content).toBeVisible();
  const left = (await content.boundingBox())!;
  const right = (await sidebar(page).boundingBox())!;
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  expect(right.x + right.width).toBeLessThanOrEqual(width + 1);
  expect(right.x).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  // A backdrop would intercept this real click; collection controls must remain usable.
  await page
    .getByRole("textbox", { name: "Search issues", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search issues", exact: true }),
  ).toBeFocused();
}

for (const width of [1440, 1024]) {
  test(`desktop list sidebar preserves filters and leaves usable non-overlapping content at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    const projectPath = await seed(page, baseURL!);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(projectPath);
    const search = page.getByRole("textbox", {
      name: "Search issues",
      exact: true,
    });
    await search.fill("Sidebar");
    await expect(page.locator(".issue-row")).toHaveCount(2);
    const alpha = issueLink(page, "Sidebar alpha");
    const beta = issueLink(page, "Sidebar beta");
    await expect(alpha).toHaveAttribute("href", /^\/issues\/.+/);
    await alpha.click();
    await expect(page).toHaveURL(projectPath);
    await expect(issueEditor(page)).toContainText("Sidebar alpha");
    await expect(alpha).toHaveAttribute("aria-current", "true");
    await expect(page.locator("article.issue-row.is-selected")).toHaveCount(1);
    await expect(
      sidebar(page).getByRole("link", { name: "Open issue in full page" }),
    ).toHaveAttribute("href", (await alpha.getAttribute("href"))!);
    await assertLayout(page, width);
    await page.screenshot({ path: `test-results/issue-sidebar-${width}.png` });
    // No confirmation should be necessary when the issue has not been edited.
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await beta.click();
    await expect(issueEditor(page)).toContainText("Sidebar beta");
    await expect(beta).toHaveAttribute("aria-current", "true");
    await expect(alpha).not.toHaveAttribute("aria-current", "true");
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(issueEditor(page)).toContainText("Sidebar beta");
    await expect(search).toHaveValue("Sidebar");
    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(issueEditor(page)).toContainText("Sidebar beta");
    await sidebar(page)
      .getByRole("button", { name: "Close issue details" })
      .click();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(page).toHaveURL(projectPath);
    await expect(search).toHaveValue("Sidebar");
    await expect(page.locator(".issue-row")).toHaveCount(2);
    await expect(page.locator(".is-selected")).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
}

test("sidebar saves synchronize titles without affecting board lanes; cards switch without navigation", async ({
  page,
  baseURL,
}) => {
  const projectPath = await seed(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await issueLink(page, "Sidebar alpha").click();
  await issueEditor(page).fill("Renamed sidebar issue");
  await expect(sidebar(page).getByLabel("Status", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    sidebar(page).getByLabel("Priority", { exact: true }),
  ).toHaveCount(0);
  await sidebar(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    sidebar(page).getByText("Changes saved", { exact: true }),
  ).toBeVisible();
  await expect(issueLink(page, "Renamed sidebar issue")).toBeVisible();
  await expect(issueLink(page, "Sidebar alpha")).toHaveCount(0);
  await expect(
    page
      .locator(".issue-row")
      .filter({ hasText: "Renamed sidebar issue" })
      .getByRole("combobox"),
  ).toHaveCount(0);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await issueLink(page, "Sidebar beta").click();
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  await sidebar(page)
    .getByRole("button", { name: "Close issue details" })
    .click();
  expect(dialogs).toEqual([]);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  const todo = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Todo/ }) });
  await expect(
    todo.getByRole("link", { name: /Renamed sidebar issue/ }),
  ).toBeVisible();
  await issueLink(page, "Sidebar beta").click();
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  const betaCard = page.locator(".board-card.is-selected");
  await betaCard
    .getByRole("combobox", { name: /Lane for issue/ })
    .selectOption("done");
  const done = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Done/ }) });
  await expect(done.locator(".board-card")).toHaveCount(1);
  await issueLink(page, "Renamed sidebar issue").click();
  await expect(issueEditor(page)).toContainText("Renamed sidebar issue");
  await expect(page).toHaveURL(`${projectPath}/board`);
  await expect(page.locator("article.board-card.is-selected")).toHaveCount(1);
  await assertLayout(page, 1440);
  await page.screenshot({ path: "test-results/issue-sidebar-board.png" });
  // Moving in the board never loses detail edits or gets overwritten by their save.
  await issueEditor(page).fill("Keep this draft while moving");
  await page
    .locator(".board-card.is-selected")
    .getByRole("combobox")
    .selectOption("in_progress");
  const progress = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^In progress/ }) });
  await expect(progress.locator(".board-card")).toHaveCount(1);
  await expect(issueEditor(page)).toContainText("Keep this draft while moving");
  await sidebar(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    sidebar(page).getByText("Changes saved", { exact: true }),
  ).toBeVisible();
  await expect(
    progress.getByRole("link", { name: /Keep this draft while moving/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    progress.getByRole("link", { name: /Keep this draft while moving/ }),
  ).toBeVisible();
  expect(dialogs).toEqual([]);
});

test("dirty issue switches and unsent comment closes require confirmation", async ({
  page,
  baseURL,
}) => {
  const projectPath = await seed(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await issueLink(page, "Sidebar alpha").click();
  await issueEditor(page).fill("Unsaved title");
  let accept = false;
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await issueLink(page, "Sidebar beta").click();
  await expect(issueEditor(page)).toContainText("Unsaved title");
  expect(dialogs).toEqual(["confirm"]);
  accept = true;
  await issueLink(page, "Sidebar beta").click();
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  await sidebar(page)
    .locator(".comments")
    .getByRole("textbox")
    .fill("Unsent comment");
  accept = false;
  await sidebar(page)
    .getByRole("button", { name: "Close issue details" })
    .click();
  await expect(
    sidebar(page).locator(".comments").getByRole("textbox"),
  ).toContainText("Unsent comment");
  expect(dialogs).toEqual(["confirm", "confirm", "confirm"]);
  accept = true;
  await sidebar(page)
    .getByRole("button", { name: "Close issue details" })
    .click();
  await expect(sidebar(page)).toHaveCount(0);
  expect(dialogs).toEqual(["confirm", "confirm", "confirm", "confirm"]);
  await issueLink(page, "Sidebar alpha").click();
  await expect(issueEditor(page)).toContainText("Sidebar alpha");
  await sidebar(page)
    .locator(".comments")
    .getByRole("textbox")
    .fill("Posted from the sidebar");
  await sidebar(page)
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(sidebar(page).locator(".comment")).toContainText(
    "Posted from the sidebar",
  );
  await issueLink(page, "Sidebar beta").click();
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  await expect(sidebar(page).locator(".comment")).toHaveCount(0);
  await issueLink(page, "Sidebar alpha").click();
  await expect(sidebar(page).locator(".comment")).toContainText(
    "Posted from the sidebar",
  );
  expect(dialogs).toHaveLength(4);
});

test("mobile links, direct issue URLs, full-page link and shrinking viewport use full-page details", async ({
  page,
  baseURL,
}) => {
  const projectPath = await seed(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(projectPath);
  const issuePath = (await issueLink(page, "Sidebar alpha").getAttribute(
    "href",
  ))!;
  await issueLink(page, "Sidebar alpha").click();
  await expect(page).toHaveURL(issuePath);
  await expect(sidebar(page)).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Issue", exact: true }),
  ).toContainText("Sidebar alpha");
  await page.goto(`${projectPath}/board`);
  await issueLink(page, "Sidebar alpha").click();
  await expect(page).toHaveURL(issuePath);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(issuePath);
  await expect(sidebar(page)).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Issue", exact: true }),
  ).toContainText("Sidebar alpha");
  await page.goto(projectPath);
  await issueLink(page, "Sidebar alpha").click();
  await sidebar(page)
    .getByRole("link", { name: "Open issue in full page" })
    .click();
  await expect(page).toHaveURL(issuePath);
  await expect(sidebar(page)).toHaveCount(0);
  await page.goto(projectPath);
  await issueLink(page, "Sidebar alpha").click();
  await expect(sidebar(page)).toBeVisible();
  await page.setViewportSize({ width: 1023, height: 844 });
  await expect(page).toHaveURL(issuePath);
  await expect(sidebar(page)).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Issue", exact: true }),
  ).toContainText("Sidebar alpha");
});

test("rapid selection ignores stale responses and failed details can retry without leaving the collection", async ({
  page,
  baseURL,
}) => {
  const projectPath = await seed(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  const alphaPath = (await issueLink(page, "Sidebar alpha").getAttribute(
    "href",
  ))!;
  const betaPath = (await issueLink(page, "Sidebar beta").getAttribute(
    "href",
  ))!;
  let releaseAlpha!: () => void;
  const alphaGate = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  await page.route(`**/api${alphaPath}`, async (route) => {
    const response = await route.fetch();
    await alphaGate;
    await route.fulfill({ response });
  });
  let failBeta = true;
  await page.route(`**/api${betaPath}`, async (route) => {
    if (failBeta) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Could not load this issue" }),
      });
    } else await route.continue();
  });
  await issueLink(page, "Sidebar alpha").click();
  await expect(sidebar(page).getByRole("status")).toBeVisible();
  await issueLink(page, "Sidebar beta").click();
  await expect(sidebar(page).getByRole("alert")).toHaveText(
    "Could not load this issue",
  );
  const alphaResponse = page.waitForResponse(`**/api${alphaPath}`);
  releaseAlpha();
  await alphaResponse;
  await expect(sidebar(page).getByRole("alert")).toHaveText(
    "Could not load this issue",
  );
  await expect(issueEditor(page)).toHaveCount(0);
  failBeta = false;
  await sidebar(page)
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  await expect(page).toHaveURL(projectPath);
  // Keyboard activation is a normal selection; modified clicks retain native links.
  await sidebar(page)
    .getByRole("button", { name: "Close issue details" })
    .click();
  await issueLink(page, "Sidebar beta").focus();
  await page.keyboard.press("Enter");
  await expect(issueEditor(page)).toContainText("Sidebar beta");
  const newTab = page.context().waitForEvent("page");
  await issueLink(page, "Sidebar alpha").click({
    modifiers: ["ControlOrMeta"],
  });
  const tab = await newTab;
  await expect(tab).toHaveURL(alphaPath);
  await expect(sidebar(page)).toBeVisible();
  await tab.close();
});

for (const width of [1440, 1024, 390]) {
  test(`the whole label-only list row opens an issue at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    const projectPath = await seed(page, baseURL!);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(projectPath);
    const alpha = page
      .locator(".issue-row")
      .filter({ hasText: "Sidebar alpha" });
    const issuePath = (await alpha.getByRole("link").getAttribute("href"))!;
    await expect(alpha.getByRole("combobox")).toHaveCount(0);

    // All of these are outside the original title link: padding and metadata.
    for (const target of ["top-left", "bottom-right", "avatar"] as const) {
      await alpha.scrollIntoViewIfNeeded();
      const box = (await alpha.boundingBox())!;
      const avatar = (await alpha.locator(".avatar").boundingBox())!;
      const point =
        target === "avatar"
          ? { x: avatar.x + avatar.width / 2, y: avatar.y + avatar.height / 2 }
          : target === "top-left"
            ? { x: box.x + 5, y: box.y + 5 }
            : { x: box.x + box.width - 5, y: box.y + box.height - 5 };
      await page.mouse.click(point.x, point.y);
      if (width >= 1024) {
        await expect(page).toHaveURL(projectPath);
        await expect(issueEditor(page)).toContainText("Sidebar alpha");
        await expect(page.locator(".issue-row select")).toHaveCount(0);
        await sidebar(page)
          .getByRole("button", { name: "Close issue details" })
          .click();
      } else {
        await expect(page).toHaveURL(issuePath);
        await expect(
          page.getByRole("textbox", { name: "Issue", exact: true }),
        ).toContainText("Sidebar alpha");
        await page.goto(projectPath);
      }
    }

    // The enlarged hit area is still a real link (including native new-tab clicks).
    if (width >= 1024) {
      const newTab = page.context().waitForEvent("page");
      await alpha.click({
        position: { x: 5, y: 5 },
        modifiers: ["ControlOrMeta"],
      });
      const tab = await newTab;
      await expect(tab).toHaveURL(issuePath);
      await expect(page).toHaveURL(projectPath);
      await expect(sidebar(page)).toHaveCount(0);
      await tab.close();
    }
  });
}
