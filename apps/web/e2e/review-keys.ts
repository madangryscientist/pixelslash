import { expect, type Page } from "@playwright/test";

/**
 * r rejects the shot on screen and fails the build; j/k then still walk the shots. Starts and ends on shot 2 of 5.
 */
export async function rejectThenWalkFailedBuild(page: Page) {
  await page.keyboard.press("r");
  await expect(page.getByTestId("review-state")).toHaveText("rejected by e2e-octocat");
  await page.keyboard.press("j");
  await expect(page.getByTestId("position")).toHaveText("3 of 5");
  await page.keyboard.press("k");
  await expect(page.getByTestId("position")).toHaveText("2 of 5");
}
