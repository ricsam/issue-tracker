import { expect, type Page } from "@playwright/test";

export const boardFilters = (page: Page) => page.getByRole("region", { name: "Board filters", exact: true });
export const filterEditor = (page: Page) => page.getByRole("dialog", { name: "Edit filter", exact: true });

export async function clearBoardFilters(page: Page) {
  await boardFilters(page).getByRole("button", { name: "Clear filters", exact: true }).click();
}

export async function addBoardFilter(page: Page, field: string, value: string, operator = "is") {
  await boardFilters(page).getByRole("button", { name: "Add filter", exact: true }).click();
  const editor = filterEditor(page);
  await expect(editor).toBeVisible();
  await editor.getByLabel("Field", { exact: true }).selectOption(field);
  await editor.getByLabel("Operator", { exact: true }).selectOption(operator);
  const control = editor.getByLabel("Value", { exact: true });
  if (field === "title" || field === "number") await control.fill(value);
  else await control.selectOption(value);
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toBeHidden();
}
