import { test, expect } from "@playwright/test";

const password = "local-browser-test-password";
test("protected workspace, projects, rich issues, uploads, board, comments and admin", async ({
  page,
  browser,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { setupRequired } = await (
    await page.request.get("/api/auth/status")
  ).json();
  await page.goto("/projects");
  if (setupRequired) {
    await expect(
      page.getByRole("heading", { name: "Make this workspace yours" }),
    ).toBeVisible();
    await page.getByLabel("Full name").fill("Alex Morgan");
  }
  await page.getByLabel("Email address").fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", {
      name: setupRequired ? "Create workspace" : "Sign in",
      exact: true,
    })
    .click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Project name").fill("Website redesign");
  await modal
    .getByLabel("Description")
    .fill("A thoughtful home for our next release.");
  await modal
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Website redesign", exact: true }),
  ).toBeVisible();
  const projectUrl = page.url();
  await page
    .getByRole("button", { name: "Create issue", exact: true })
    .first()
    .click();
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel("Issue title", { exact: true })).toHaveCount(0);
  const editor = modal.getByRole("textbox", { name: "Issue", exact: true });
  await expect(editor).toBeFocused();
  await editor.fill("Make the first five minutes feel effortless.");
  await editor.press("ControlOrMeta+A");
  await modal.getByRole("button", { name: "Bold", exact: true }).click();
  await modal.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(modal.getByLabel("Markdown source")).toHaveValue(
    /\*\*Make the first five minutes feel effortless\.\*\*/,
  );
  await modal
    .getByLabel("Markdown source")
    .fill(
      "# Improve the onboarding experience\n\n## A better first impression\n\n**Small steps**, meaningful progress.\n\n- [ ] Welcome message\n- [ ] Project checklist\n\n#design #enhancement\n",
    );
  await modal.getByRole("button", { name: "Write", exact: true }).click();
  await expect(
    modal.getByRole("heading", { name: "A better first impression" }),
  ).toBeVisible();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  await modal.getByLabel("Upload attachments").setInputFiles({
    name: "design (v1).png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    modal.getByRole("img", { name: "design (v1).png" }),
  ).toBeVisible();
  await expect(modal.getByRole("combobox")).toHaveCount(1);
  await expect(modal.getByRole("combobox", { name: "Project", exact: true })).toBeVisible();
  await expect(editor).toContainText("#design #enhancement");
  await modal
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await expect(modal.getByRole("status")).toContainText(/Issue #\d+ created\./);
  await expect(page).toHaveURL(projectUrl);
  await expect(editor).toBeEmpty();
  await expect(editor).toBeFocused();
  await expect(modal.getByRole("list", { name: "Labels", exact: true })).toHaveCount(0);
  await modal.getByRole("link", { name: "View issue", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(projectUrl);
  await page.getByRole("link", { name: "Open issue in full page" }).click();
  await expect(page).toHaveURL(/\/issues\/[a-z0-9-]+$/);
  await expect(
    page.locator(".detail-form .editor-preview"),
  ).toContainText("Improve the onboarding experience");
  const issueUrl = page.url();
  await expect(
    page.getByRole("combobox", { name: "Priority", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Tagged users", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  const commentEditor = page.locator(".comments .rich-editor");
  await commentEditor
    .locator("[contenteditable=true]")
    .fill("The first draft is ready for review.");
  await commentEditor.getByLabel("Upload attachments").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Review notes"),
  });
  await expect(
    commentEditor.getByRole("link", { name: "notes.txt" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /post comment|comment/i })
    .last()
    .click();
  await expect(
    page.locator(".comment").getByText(/The first draft is ready for review/),
  ).toBeVisible();
  const attachmentUrl = await page
    .locator(".comment")
    .getByRole("link", { name: "notes.txt" })
    .getAttribute("href");
  expect(attachmentUrl).toBeTruthy();
  const privateDownload = await page.request.get(attachmentUrl!);
  expect(privateDownload.status()).toBe(200);
  expect(privateDownload.headers()["content-disposition"]).toContain(
    "attachment",
  );
  const anonymous = await browser.newContext();
  expect(
    (await anonymous.request.get(`${baseURL}${attachmentUrl}`)).status(),
  ).toBe(401);
  expect(
    (await anonymous.request.get(`${baseURL}/api/projects`)).status(),
  ).toBe(401);
  await anonymous.close();
  await page.goto(projectUrl + "/board");
  await expect(page.locator(".board-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add issues to board" });
  await add.getByRole("checkbox", { name: /Add issue #1:/ }).check();
  await add.getByLabel("Lane", { exact: true }).selectOption("in_progress");
  await add.getByRole("button", { name: "Add to board", exact: true }).click();
  await expect(add).toBeHidden();
  const inProgress = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /In progress/ }) });
  await expect(
    inProgress.getByRole("link", { name: /Improve the onboarding/ }),
  ).toBeVisible();
  const done = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: /Done/ }) });
  // Start the native drag with small moves over the narrow handle before
  // crossing the board (one large jump can skip Chromium's drag threshold).
  const handle = inProgress.locator(".board-card-handle");
  const start = (await handle.boundingBox())!;
  const end = (await done.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2, { steps: 5 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(
    done.getByRole("link", { name: /Improve the onboarding/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    done.getByRole("link", { name: /Improve the onboarding/ }),
  ).toBeVisible();
  await expect(done.getByText("design", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/board-desktop.png",
    fullPage: true,
  });
  await page.goto(issueUrl);
  await expect(
    page.getByRole("img", { name: "design (v1).png" }),
  ).toBeVisible();
  await expect(page.locator(".comment").getByText(/first draft/)).toBeVisible();
  await page.screenshot({
    path: "test-results/issue-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator(".detail-form .editor-preview"),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("body *"))
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.right > innerWidth + 1;
        })
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          right: el.getBoundingClientRect().right,
        })),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/issue-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: /administration|settings/i }).first(),
  ).toBeVisible();
  await page.getByLabel("Provider name").fill("Acme SSO");
  await page.getByLabel("Issuer URL").fill("https://identity.example.test");
  await page.getByLabel("Client ID", { exact: true }).fill("threadline");
  await page
    .getByLabel("Client secret", { exact: true })
    .fill("test-client-secret");
  await page.getByRole("button", { name: "Save OIDC settings" }).click();
  await expect(
    page.getByText("Single sign-on settings saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Client secret", { exact: true })).toHaveValue(
    "",
  );
  await page.reload();
  await expect(page.getByLabel("Provider name")).toHaveValue("Acme SSO");
  await expect(page.getByLabel("Client secret", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Full name").fill("Jamie Rivera");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Temporary password").fill(password);
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(
    page.getByText("Local user created. Share their credentials securely."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Administrator access required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  await page.goto("/projects");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await modal.getByLabel("Project name").fill("Member-owned project");
  await modal
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Member-owned project", exact: true }),
  ).toBeVisible();
  await page.goto(issueUrl);
  await page.locator(".detail-form").getByRole("button", { name: "Write", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Issue", exact: true })
    .fill("Onboarding ready for review");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await expect(
    page.locator(".comment").getByRole("button", { name: /edit|delete/i }),
  ).toHaveCount(0);
  // Expired sessions return to the login gate rather than leaving workspace data onscreen.
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Issue", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
