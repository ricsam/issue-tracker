import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const auth = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(auth.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

test("creation chooses a visible custom lane, repeats placement and resets when switching project", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Create lanes ${randomUUID()}` } })).json();
  const { project: other } = await (await page.request.post("/api/projects", { headers, data: { name: `Other lanes ${randomUUID()}` } })).json();
  const custom = `custom_${randomUUID()}`;
  const endpoint = `/api/projects/${project.slug}/board`;
  expect((await page.request.patch(endpoint, { headers, data: { lanes: ["todo", custom], customLanes: [{ value: custom, label: "Review" }] } })).ok()).toBeTruthy();
  await page.goto(`/projects/${project.slug}/board`);
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create issue" });
  const lane = modal.getByRole("combobox", { name: "Board lane", exact: true });
  await expect(lane).toBeEnabled();
  await expect(lane).toHaveValue("");
  await expect(lane.locator("option")).toHaveText(["Not on board", "Todo", "Review"]);
  await lane.selectOption(custom);
  for (const body of ["First review issue", "Second review issue"]) {
    await modal.getByRole("textbox", { name: "Issue", exact: true }).fill(body);
    await modal.getByRole("button", { name: "Create issue", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Issue", exact: true })).toBeEmpty();
    await expect(lane).toHaveValue(custom);
  }
  await modal.getByRole("combobox", { name: "Project", exact: true }).selectOption(other.id);
  await expect(lane).toBeEnabled();
  await expect(lane).toHaveValue("");
  await expect(lane.locator("option")).toHaveText(["Not on board", "Todo", "In progress", "Done"]);
  await modal.getByRole("combobox", { name: "Project", exact: true }).selectOption("");
  await expect(lane).toHaveCount(0);
  await modal.getByRole("textbox", { name: "Issue", exact: true }).fill("Unlinked creation");
  await modal.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(modal.getByRole("textbox", { name: "Issue", exact: true })).toBeEmpty();
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(2);
  expect((await (await page.request.get(endpoint)).json()).board.cards.map((card: { lane: string }) => card.lane)).toEqual([custom, custom]);
  await page.reload();
  await expect(page.locator(".board-card")).toHaveCount(2);
});

test("a now-hidden creation lane fails atomically and retains the draft for correction", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Stale lane ${randomUUID()}` } })).json();
  const path = `/api/projects/${project.slug}`;
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create issue" });
  const lane = modal.getByRole("combobox", { name: "Board lane", exact: true });
  await expect(lane).toBeEnabled();
  await lane.selectOption("done");
  expect((await page.request.patch(`${path}/board`, { headers, data: { lanes: ["todo"] } })).ok()).toBeTruthy();
  await modal.getByRole("textbox", { name: "Issue", exact: true }).fill("Keep this draft");
  await modal.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(modal.getByRole("alert")).toBeVisible();
  await expect(modal.getByRole("textbox", { name: "Issue", exact: true })).toContainText("Keep this draft");
  expect((await (await page.request.get(`${path}/issues`)).json()).issues).toHaveLength(0);
  await lane.selectOption("");
  await modal.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(modal.getByRole("textbox", { name: "Issue", exact: true })).toBeEmpty();
  expect((await (await page.request.get(`${path}/issues`)).json()).issues).toHaveLength(1);
  expect((await (await page.request.get(`${path}/board`)).json()).board.cards).toEqual([]);
});

test("global lane creation survives a stale load, then moving updates All issues and never resurrects old board snapshots", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Global move ${randomUUID()}` } })).json();
  const { project: target } = await (await page.request.post("/api/projects", { headers, data: { name: `Move target ${randomUUID()}` } })).json();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const stale = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response: stale });
  });
  await page.goto("/issues");
  await started;
  let id = "";
  try {
    await page.getByRole("button", { name: "Create issue (Alt+N)", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
    await dialog.getByRole("combobox", { name: "Project", exact: true }).selectOption(project.id);
    await dialog.getByRole("combobox", { name: "Board lane", exact: true }).selectOption("todo");
    await dialog.getByRole("textbox", { name: "Issue", exact: true }).fill("Globally created movable issue");
    await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
    const link = dialog.getByRole("link", { name: "View issue" });
    await expect(link).toBeVisible();
    id = (await link.getAttribute("href"))!.split("/").at(-1)!;
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
  } finally { release(); }
  await page.getByRole("textbox", { name: "Search issues", exact: true }).fill(`!${id}`);
  const row = page.locator(".issue-row").filter({ has: page.locator(`a[data-issue-id="${id}"]`) });
  await expect(row).toContainText("Todo");
  await page.unroute("**/api/issues");
  await row.locator(".issue-link").click();
  await page.locator(".detail-form").getByRole("button", { name: "Move issue", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move issue", exact: true });
  await move.getByLabel("Destination project").selectOption(target.id);
  await move.getByRole("button", { name: "Move issue", exact: true }).click();
  await expect(move).toBeHidden();
  await expect(row).toContainText(target.name);
  await expect(row).toContainText("Not on board");
  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  // SPA route changes keep the creation provider mounted: its old snapshots must be ignored.
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: project.name, exact: true }).click();
  await expect(page.locator(`a[data-issue-id="${id}"]`)).toHaveCount(0);
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(0);
  await expect(page.locator(".board-summary")).toContainText("0 of 0 issues assigned to board");
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: target.name, exact: true }).click();
  await expect(page.locator(`a[data-issue-id="${id}"]`)).toBeVisible();
});

test("add-to-board uses a tri-state matching checkbox and shift ranges without clearing hidden selections", async ({ page, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Selection ${randomUUID()}` } })).json();
  const issues: { id: string; number: number }[] = [];
  for (const body of ["Apple one", "Banana two", "Banana three", "Banana four", "Cherry five"]) {
    issues.push((await (await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body } })).json()).issue);
  }
  await page.goto(`/projects/${project.slug}/board`);
  await page.getByRole("button", { name: "Add issues", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Add issues to board" });
  const header = modal.getByRole("checkbox", { name: "Select all matching issues", exact: true });
  const row = (index: number) => modal.getByRole("checkbox", { name: new RegExp(`^Add issue !${issues[index].number}:`) });
  await expect(header).not.toBeChecked();
  await row(0).click();
  await expect(header).toBeChecked({ indeterminate: true });
  await row(3).click({ modifiers: ["Shift"] });
  for (let index = 0; index < 4; index++) await expect(row(index)).toBeChecked();
  await row(1).click();
  await row(3).click({ modifiers: ["Shift"] });
  for (let index = 1; index < 4; index++) await expect(row(index)).not.toBeChecked();
  const search = modal.getByRole("textbox", { name: "Search issues to add to board" });
  await search.fill("Banana");
  await expect(header).not.toBeChecked();
  await header.check();
  await expect(header).toBeChecked();
  await expect(modal.getByRole("status")).toContainText("4 selected");
  await header.uncheck();
  await expect(modal.getByRole("status")).toContainText("1 selected");
  await search.fill("missing");
  await expect(header).toBeDisabled();
  await search.fill("");
  await expect(row(0)).toBeChecked();
  await expect(header).toBeChecked({ indeterminate: true });
  await header.check();
  await expect(header).toBeChecked();
  await modal.getByRole("button", { name: "Add to board", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator(".board-card")).toHaveCount(5);
});
