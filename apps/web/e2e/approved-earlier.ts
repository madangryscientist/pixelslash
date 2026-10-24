import { expect, type Page } from "@playwright/test";

/**
 * On a build page just accepted, `reupload` sends the same pixels again and opens the project. The
 * new build reads unchanged (ob 1722): the build page says how many were approved earlier, the
 * shot's line names the approval, and the side panel links to the accepted shot on that build.
 */
export async function expectApprovedEarlier(
  page: Page,
  reupload: () => Promise<void>,
  capture: (page: Page, name: string) => Promise<void>,
) {
  const approvingBuildId = /\/builds\/([^/?]+)/.exec(page.url())?.[1] ?? "";
  await reupload();
  await page.getByTestId("build-row").first().getByRole("link", { name: "review" }).click();
  await expect(page.getByTestId("approved-earlier-count")).toHaveText(
    "3 approved earlier on this branch",
  );
  await page.getByTestId("tab-unchanged").click();
  await page.getByTestId("unchanged-show").click();
  const about = page.getByTestId("snapshot-row").filter({ hasText: "about" });
  await expect(about).toContainText(
    /no change since build [0-9a-f]{7} · change from main approved by e2e-octocat/,
  );
  // The shot unchanged against main has nothing to say about an approval.
  await expect(page.getByTestId("snapshot-row").filter({ hasText: "home" })).toContainText(
    /identical to baseline: same bytes, not diffed$/,
  );
  await capture(page, "08-approved-earlier-build");
  await about.getByRole("link").click();
  const panel = page.getByTestId("approved-earlier");
  await expect(panel).toContainText(/Approved on build [0-9a-f]{7} by e2e-octocat/);
  await capture(page, "09-approved-earlier-shot");
  await panel.getByTestId("approved-earlier-link").click();
  await expect(page).toHaveURL(new RegExp(`/builds/${approvingBuildId}/snapshots/`));
  await expect(page.getByTestId("review-state")).toHaveText(/accepted by e2e-octocat/);
}
