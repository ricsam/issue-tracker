import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import type { Issue, User } from "../shared/types";

let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
test.beforeAll(async ({ request, baseURL }) => {
  const { setupRequired } = await (await request.get("/api/auth/status")).json();
  const response = await request.post(setupRequired ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: baseURL! },
    data: { ...(setupRequired ? { name: "Alex Morgan" } : {}), email: "alex@example.test", password: "local-browser-test-password" },
  });
  expect(response.ok()).toBeTruthy();
  session = await request.storageState();
});
test.beforeEach(async ({ context }) => { await context.addCookies(session.cookies); });

for (const all of [false, true]) {
  test(`creator displays, sorts and filters in ${all ? "all issues" : "project issues"}`, async ({ page, baseURL }) => {
    const headers = { Origin: baseURL! };
    const projectResponse = await page.request.post("/api/projects", { headers, data: { name: `Creators ${randomUUID()}` } });
    expect(projectResponse.ok()).toBeTruthy();
    const { project } = await projectResponse.json();
    const issues: Issue[] = [];
    for (const body of ["Created by Bea", "Created by Alex", "Unknown creator"]) {
      const response = await page.request.post(`/api/projects/${project.slug}/issues`, { headers, data: { body } });
      expect(response.ok()).toBeTruthy();
      issues.push((await response.json()).issue);
    }
    const { users }: { users: User[] } = await (await page.request.get("/api/users")).json();
    const alex = users.find((user) => user.email === "alex@example.test")!;
    const bea: User = { ...alex, id: `creator-${randomUUID()}`, name: "Bea", email: "bea@example.test" };
    // Exercise missing users without mutating accounts or persisted issue authors.
    await page.route("**/api/users", (route) => route.fulfill({ json: { users: [...users, bea] } }));
    issues[0].authorId = bea.id;
    issues[1].authorId = alex.id;
    issues[2].authorId = "missing-creator";
    await page.route(all ? "**/api/issues" : `**/api/projects/${project.slug}/issues`, (route) => route.fulfill({ json: { issues, boards: {} } }));
    await page.goto(all ? "/issues" : `/projects/${project.slug}`);
    const table = page.getByRole("table");
    const titles = table.locator("tbody .issue-link");
    await expect(table.locator(".issue-creator")).toHaveText(["Bea", "Alex Morgan", "Unknown user"]);
    await table.getByRole("button", { name: "Sort by creator", exact: true }).click();
    await expect(titles).toHaveText(["Created by Alex", "Created by Bea", "Unknown creator"]);
    await expect(table.locator('th[aria-sort="ascending"]')).toContainText("Creator");
    await table.getByRole("button", { name: "Sort by creator", exact: true }).click();
    await expect(titles).toHaveText(["Unknown creator", "Created by Bea", "Created by Alex"]);
    await table.getByRole("button", { name: "Creator filters", exact: true }).click();
    const filter = table.getByLabel("Filter by creator", { exact: true });
    await expect(filter).toBeFocused();
    await filter.selectOption(`user:${alex.id}`);
    await expect(titles).toHaveText(["Created by Alex"]);
    await page.getByRole("dialog", { name: "Creator filters", exact: true }).getByRole("button", { name: "Clear creator filter", exact: true }).click();
    await expect(titles).toHaveCount(3);
    await filter.selectOption("unknown");
    await page.getByRole("dialog", { name: "Creator filters", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
    await expect(titles).toHaveText(["Unknown creator"]);
    await expect(table.getByRole("button", { name: "Creator filters (active)", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Clear column filters", exact: true }).click();
    await expect(titles).toHaveText(["Unknown creator", "Created by Bea", "Created by Alex"]);
    await expect(table.locator('th[aria-sort="descending"]')).toContainText("Creator");
  });
}
