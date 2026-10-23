import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/** Server build timings (ob 1792): the numbers a real diff run stores, on the build page and the org's Timings tab. */

test("a diffed build shows its server timings, and the org's Timings tab their p50/p95", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Timings Co", "timed");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  const timings = page.getByTestId("build-timings");
  await expect(timings).toBeVisible();
  await expect(page.getByTestId("timing-server-diff")).toHaveText(/diff\s+\d/);
  await expect(page.getByTestId("timing-server-queue")).toBeVisible();
  await expect(page.getByTestId("timing-server-total")).toBeVisible();
  // No model on this project: nothing is claimed for steps that did not run.
  await expect(page.getByTestId("timing-server-explain")).toHaveCount(0);

  await open(page, "/orgs");
  await page.getByTestId("org-link").filter({ hasText: "Timings Co" }).click();
  await expect(page.getByRole("heading", { name: "Timings Co", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Timings", exact: true }).click();
  await expect(page).toHaveURL(/tab=timings/);
  const row = page.getByTestId("timings-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("timed");
  await expect(row.getByTestId("timings-builds")).toHaveText("2");
  await expect(row.getByTestId("timings-diff")).toHaveText(/\d.* \/ .*\d/);
  await expect(row.getByTestId("timings-summary")).toHaveText("—");
});
