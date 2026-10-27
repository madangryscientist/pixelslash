import { expect, type Page } from "@playwright/test";

/**
 * r rejects the shot on screen and fails the build. The reviewer goes to the build page, which shows
 * the failed state; the shot is reopened from there and j/k still walk the shots. Starts on shot 2
 * of 5.
 */
export async function rejectThenWalkFailedBuild(page: Page, buildUrl: string) {
  await page.keyboard.press("r");
  await page.waitForURL(new RegExp(`${new URL(buildUrl).pathname}(\\?.*)?$`));
  await expect(page.getByTestId("build-status")).toHaveText("failed");
  await page.getByTestId("group-changed").getByRole("link", { name: /hero/i }).click();
  await expect(page.getByTestId("review-state")).toHaveText("rejected by e2e-octocat");
  await page.keyboard.press("j");
  await expect(page.getByTestId("position")).toHaveText("3 of 5");
  await page.keyboard.press("k");
  await expect(page.getByTestId("position")).toHaveText("2 of 5");
}
