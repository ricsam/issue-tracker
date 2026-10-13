import type { Page } from "@playwright/test";

export async function laneAction(page: Page, lane: string, action: string) {
  await page.getByRole("button", { name: `${lane} lane actions`, exact: true }).click();
  await page.getByRole("menu", { name: `${lane} lane actions`, exact: true }).getByRole("menuitem", { name: action, exact: true }).click();
}
