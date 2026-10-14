import { expect, type Page } from "@playwright/test";

export const filterEditor = (page: Page) => page.getByRole("dialog", { name: "Edit filter", exact: true });
const labels: Record<string, string> = { lane: "Board lane", title: "Issue", number: "Number", labels: "Tags", tagged: "Tagged users", creator: "Creator", created: "Created", project: "Project", state: "State" };

/** Open an existing single-field condition, or create it through the visible filter bar. */
export async function openTableFilter(page: Page, field: string) {
  await expect(page.getByRole("region", { name: "Table filters", exact: true })).toBeVisible();
  const chip = page.getByRole("region", { name: "Table filters", exact: true }).getByRole("button", { name: new RegExp(`^Edit filter: ${labels[field]} `) }).first();
  if (await chip.count()) await chip.click();
  else {
    await page.getByRole("region", { name: "Table filters", exact: true }).getByRole("button", { name: "Add filter", exact: true }).click();
    await filterEditor(page).getByLabel("Field", { exact: true }).selectOption(field);
  }
  await expect(filterEditor(page)).toBeVisible();
  return filterEditor(page);
}

export async function setTableState(page: Page, state: "open" | "closed" | "draft") {
  const editor = await openTableFilter(page, "state");
  await editor.getByLabel("Value", { exact: true }).selectOption(state);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
}
