import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, baseURL: string, name: string) {
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
  const { project } = await (
    await page.request.post("/api/projects", {
      headers,
      data: { name: `${name} ${randomUUID().slice(0, 8)}` },
    })
  ).json();
  const issues: { id: string }[] = [];
  for (const body of ["# Ship the beta\n\nFinal checks.", "Write release notes"]) {
    const created = await page.request.post(
      `/api/projects/${project.slug}/issues`,
      { headers, data: { body } },
    );
    expect(created.ok()).toBeTruthy();
    issues.push((await created.json()).issue);
  }
  const placed = await page.request.post(
    `/api/projects/${project.slug}/board/issues`,
    { headers, data: { issueIds: issues.map((i) => i.id), lane: "todo" } },
  );
  expect(placed.ok()).toBeTruthy();
  return { headers, project, issues };
}

test("issues close and reopen without losing edits, filter the list and stay on the board", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { headers, project, issues } = await seed(page, baseURL!, "Lifecycle");
  const projectPath = `/projects/${project.slug}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/issues/${issues[0]!.id}`);

  // The heading actions keep clear space above the editor and properties card.
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  const properties = page.locator(".properties");
  await expect(save).toBeVisible();
  const saveBox = (await save.boundingBox())!;
  const propertiesBox = (await properties.boundingBox())!;
  const editorBox = (await page.locator(".detail-grid .rich-editor").boundingBox())!;
  expect(propertiesBox.y - (saveBox.y + saveBox.height)).toBeGreaterThanOrEqual(12);
  expect(editorBox.y - (saveBox.y + saveBox.height)).toBeGreaterThanOrEqual(12);

  await expect(page.locator(".detail-heading .state-badge")).toHaveText("Open");
  const editor = page.getByRole("textbox", { name: "Issue", exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Draft kept.");
  await page.getByRole("button", { name: "Close issue", exact: true }).click();
  await expect(page.locator(".detail-heading .state-badge")).toHaveText("Closed");
  await expect(page.getByText("Issue closed", { exact: true })).toBeVisible();
  await expect(page.locator(".closed-meta")).toContainText("Alex Morgan");
  // Closing saved only the state; the unsaved draft is still pending.
  await expect(editor).toContainText("Draft kept.");
  let saved = (await (await page.request.get(`/api/issues/${issues[0]!.id}`)).json()).issue;
  expect(saved.state).toBe("closed");
  expect(saved.body).not.toContain("Draft kept.");
  await save.click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  saved = (await (await page.request.get(`/api/issues/${issues[0]!.id}`)).json()).issue;
  expect(saved).toMatchObject({ state: "closed", body: expect.stringContaining("Draft kept.") });
  await page.reload();
  await expect(page.getByRole("button", { name: "Reopen issue", exact: true })).toBeVisible();

  // The list defaults to open issues and links to the closed ones.
  await page.goto(projectPath);
  const state = page.getByRole("navigation", { name: "Issue state" });
  await expect(state.getByRole("link", { name: /Open/ })).toContainText("1");
  await expect(state.getByRole("link", { name: /Closed/ })).toContainText("1");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(page.locator(".issue-row")).toContainText("Write release notes");
  await state.getByRole("link", { name: /Closed/ }).click();
  await expect(page).toHaveURL(/\?state=closed$/);
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await expect(page.locator(".issue-row")).toContainText("Ship the beta");
  await expect(page.locator(".issue-row .closed-tag")).toHaveText("Closed");
  await page.reload();
  await expect(page.locator(".issue-row")).toContainText("Ship the beta");

  // Reopening from the side panel moves it back to the open list.
  await page.locator(".issue-row .issue-link").click();
  const panel = page.getByRole("complementary", { name: "Issue details", exact: true });
  await panel.getByRole("button", { name: "Reopen issue", exact: true }).click();
  await expect(panel.locator(".state-badge")).toHaveText("Open");
  await expect(page.locator(".issue-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No closed issues" })).toBeVisible();
  await expect(state.getByRole("link", { name: /Open/ })).toContainText("2");
  await panel.getByRole("button", { name: "Close issue details", exact: true }).click();

  // Closed cards keep their lane on the board and are clearly marked.
  const closeSecond = await page.request.patch(`/api/issues/${issues[1]!.id}`, {
    headers,
    data: { state: "closed" },
  });
  expect(closeSecond.ok()).toBeTruthy();
  await page.goto(`${projectPath}/board`);
  const todo = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /^Todo/ }) });
  await expect(todo.locator(".board-card")).toHaveCount(2);
  const closedCard = todo.locator(".board-card.is-closed");
  await expect(closedCard).toHaveCount(1);
  await expect(closedCard).toContainText("Write release notes");
  await expect(closedCard.locator(".closed-tag")).toBeVisible();
  // Closed work is not offered when planning the board.
  await page.request.delete(
    `/api/projects/${project.slug}/board/issues/${issues[1]!.id}`,
    { headers },
  );
  await page.reload();
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add issues to board" });
  await expect(add.getByRole("checkbox")).toHaveCount(0);
  await expect(add.getByText("All open issues are already on the board.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("archived projects leave navigation, become read-only and can be restored", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { headers, project, issues } = await seed(page, baseURL!, "Archive me");
  const comment = await page.request.post(`/api/issues/${issues[0]!.id}/comments`, {
    headers,
    data: { body: "Kept for reference" },
  });
  expect(comment.ok()).toBeTruthy();
  const projectPath = `/projects/${project.slug}`;
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await expect(nav.getByRole("link", { name: project.name })).toBeVisible();

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Archive project?" });
  await expect(dialog).toContainText("read-only");
  await dialog.getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(dialog).toBeHidden();
  const notice = page.getByRole("region", { name: "Archived project" });
  await expect(notice).toContainText("This project is archived.");
  await expect(notice).toContainText("Alex Morgan");
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: project.name })).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/projects/${project.slug}`)).json()).project
      .archivedAt,
  ).toBeTruthy();

  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add issues", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage lanes" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: /Lane for issue #1/ })).toBeDisabled();
  await expect(page.locator(".board-card").first()).toHaveAttribute("draggable", "false");
  await expect(page.locator(".board-column h2").first()).toHaveAttribute("draggable", "false");

  await page.goto(`/issues/${issues[0]!.id}`);
  await expect(page.locator(".read-only-note")).toContainText("archived project");
  await expect(page.getByRole("article", { name: "Issue" })).toContainText("Ship the beta");
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toHaveCount(0);
  for (const name of ["Close issue", "Save changes", "Post comment", "Edit comment", "Delete comment"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.locator(".comment")).toContainText("Kept for reference");
  await expect(page.getByRole("combobox", { name: "Assignee" })).toBeDisabled();

  // Archived projects are listed separately from active work.
  await page.goto("/projects");
  await expect(page.locator(".project-card").filter({ hasText: project.name })).toHaveCount(0);
  const status = page.getByRole("navigation", { name: "Project status" });
  await status.getByRole("link", { name: /Archived/ }).click();
  await expect(page).toHaveURL(/\/projects\?view=archived$/);
  await expect(page.getByRole("heading", { name: /Archived projects/ })).toBeVisible();
  const card = page.locator(".project-card").filter({ hasText: project.name });
  await expect(card).toContainText("Archived");
  await card.click();
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));

  // Narrow screens keep the notice and actions within the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await notice.getByRole("button", { name: "Restore project" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: project.name })).toBeVisible();
  const restored = (await (await page.request.get(`/api/projects/${project.slug}`)).json()).project;
  expect(restored).toMatchObject({ archivedAt: null, archivedById: null });
  await page.goto(`/issues/${issues[0]!.id}`);
  await expect(page.getByRole("button", { name: "Close issue", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Issue", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
