import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { addBoardFilter, boardFilters, clearBoardFilters } from "./board-filter-helpers";
import { laneAction } from "./board-lane-helpers";

const password = "local-browser-test-password";
test("project defaults, browser overrides and reset remain independent across users and browsers", async ({ page, browser, baseURL }) => {
  const headers = { Origin: baseURL! };
  const { setupRequired } = await (await page.request.get("/api/auth/status")).json();
  expect((await page.request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", { headers, data: {
    ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password,
  } })).ok()).toBeTruthy();
  const { project } = await (await page.request.post("/api/projects", { headers, data: { name: `Defaults ${randomUUID()}` } })).json();
  const endpoint = `/api/projects/${project.slug}/board`;
  const route = `/w/default/projects/${project.slug}/board`;
  for (const tag of ["bug", "feature"]) {
    expect((await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body: `${tag} default card #${tag}`, lane: "todo" } })).ok()).toBeTruthy();
  }
  await page.goto(route);
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  // A lane appearance write must not pin the inherited open filter.
  await laneAction(page, "Done", "Collapse");
  const defaults = { conjunction: "and", conditions: [{ id: "bug", field: "labels", operator: "is", value: "label:bug" }] };
  expect((await page.request.patch(`${endpoint}/default-filters`, { headers, data: { filters: defaults } })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Project filter defaults" })).toContainText("Using project default filters.");
  // Explicit empty filters override the project default, even after a reload.
  await clearBoardFilters(page);
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".board-card:visible")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Restore default filters", exact: true })).toBeVisible();

  const other = await browser.newContext({ baseURL });
  const memberContext = await browser.newContext({ baseURL });
  try {
    const second = await other.newPage();
    expect((await second.request.post("/api/auth/login", { headers, data: { email: "alex@example.test", password } })).ok()).toBeTruthy();
    await second.goto(route);
    await expect(second.locator(".board-card:visible")).toHaveCount(1);
    await expect(boardFilters(second).getByRole("button", { name: "Edit filter: Tags is #bug", exact: true })).toBeVisible();
    // The owner changes only shared defaults, not another browser's override.
    await clearBoardFilters(second);
    await addBoardFilter(second, "labels", "label:feature");
    await second.getByRole("button", { name: "Save filters as project default", exact: true }).click();
    await expect(second.getByRole("region", { name: "Project filter defaults" })).toContainText("Project defaults saved.");
    expect((await (await page.request.get(endpoint)).json()).board.defaultFilters.conditions[0].value).toBe("label:feature");
    await page.reload();
    await expect(page.locator(".board-card:visible")).toHaveCount(2);
    await page.getByRole("button", { name: "Restore default filters", exact: true }).click();
    await expect(page.locator(".board-card:visible")).toHaveCount(1);
    await expect(page.locator(".board-card:visible")).toContainText("feature default card");
    await expect(page.locator('[data-lane="done"]')).toHaveClass(/is-collapsed/);
    await page.reload();
    await expect(page.getByRole("region", { name: "Project filter defaults" })).toContainText("Using project default filters.");

    const email = `default-member-${randomUUID()}@example.test`;
    expect((await page.request.post("/api/admin/users", { headers, data: { email, password, name: "Defaults member" } })).ok()).toBeTruthy();
    const member = await memberContext.newPage();
    expect((await member.request.post("/api/auth/login", { headers, data: { email, password } })).ok()).toBeTruthy();
    await member.goto(route);
    await expect(member.locator(".board-card:visible")).toHaveCount(1);
    await expect(member.getByRole("button", { name: "Save filters as project default", exact: true })).toHaveCount(0);
    const writes: string[] = [];
    member.on("request", request => { if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.url()); });
    await clearBoardFilters(member);
    await expect(member.locator(".board-card:visible")).toHaveCount(2);
    expect(writes).toEqual([]);
    expect((await (await page.request.get(endpoint)).json()).board.defaultFilters.conditions[0].value).toBe("label:feature");
    // Removing defaults restores global open-state only where there is no override.
    await page.getByRole("button", { name: "Remove project default", exact: true }).click();
    await expect(page.getByRole("region", { name: "Project filter defaults" })).toContainText("Project defaults removed.");
    await expect(boardFilters(page).getByRole("button", { name: "Edit filter: State is Open", exact: true })).toBeVisible();
    await member.reload();
    await expect(boardFilters(member).getByRole("button", { name: /^Edit filter:/ })).toHaveCount(0);
  } finally { await other.close(); await memberContext.close(); }
});
