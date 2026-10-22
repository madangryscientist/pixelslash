import { expect, type Page } from "@playwright/test";

/** What the stub judge says of every changed shot; `upload --judge` puts it on PATH. */
export const JUDGE_SAYS = "A red block appeared on the page";

/**
 * The branch page (ob 1723), from the project page with one main build and one build on `branch`
 * that changes about and hero and adds pricing. Against main lists the three as waiting; since last
 * build is the build page's view; accepting one here is the same decision the build page shows.
 * The feature build was uploaded with `--judge`, so each changed shot carries the stub's sentence.
 */
export async function expectBranchPage(
  page: Page,
  projectId: string,
  branch: string,
  capture: (page: Page, name: string) => Promise<void>,
) {
  await page.getByTestId("build-row").first().getByTestId("branch-link").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/branches/${branch}$`));
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  await expect(page.getByTestId("summary-changed")).toContainText("3");
  await expect(page.getByTestId("summary-waiting")).toContainText("3");
  await expect(page.getByTestId("merge-verdict")).toHaveText("Not ready to merge: 3 waiting");
  const lines = page.getByTestId("change-summary").getByTestId("change-line");
  await expect(lines).toHaveCount(3);
  await expect(lines.filter({ hasText: "pricing" })).toContainText("new: nothing to compare with");
  // The judge (a stub on PATH, ob 1745) wrote one sentence per changed shot; the new one has none.
  for (const name of ["about", "hero"])
    await expect(lines.filter({ hasText: name }).getByTestId("change-note")).toHaveText(
      `${JUDGE_SAYS}. `,
    );
  await expect(lines.filter({ hasText: "pricing" }).getByTestId("change-note")).toHaveCount(0);
  await expect(page.getByTestId("change-note-source")).toBeVisible();
  await capture(page, "10-branch-against-main");

  // Since last build: the branch's only build, so the same shots as the build page's tabs.
  await page.getByTestId("mode-since").click();
  await expect(page).toHaveURL(/\?mode=since$/);
  await expect(page.getByTestId("mode-body-since")).toBeVisible();
  await expect(page.getByTestId("since-changed").getByTestId("snapshot-row")).toHaveCount(2);
  await capture(page, "11-branch-since-last-build");
  await page.getByTestId("mode-main").click();
  await expect(page.getByTestId("mode-body-main")).toBeVisible();

  // Accept about against main: it moves to Accepted, and the build page reads the same decision.
  const about = page.getByTestId("main-row").filter({ hasText: "about" });
  await about.getByTestId("main-accept").click();
  await expect(about).toHaveAttribute("data-group", "accepted");
  await expect(about.getByTestId("main-row-who")).toHaveText(
    /^accepted by e2e-octocat on build [0-9a-f]{7}$/,
  );
  await expect(page.getByTestId("summary-waiting")).toContainText("2");
  await expect(page.getByTestId("summary-accepted")).toContainText("1");
  await capture(page, "12-branch-accepted-one");

  await page.getByTestId("branch-head").click();
  await expect(page).toHaveURL(/\/builds\//);
  await expect(
    page.getByTestId("snapshot-row").filter({ hasText: "about" }).getByTestId("review-state"),
  ).toHaveText(/accepted by e2e-octocat/);
  await expect(
    page.getByTestId("snapshot-row").filter({ hasText: "hero" }).getByTestId("shot-change-note"),
  ).toHaveText(`Judge (local model): ${JUDGE_SAYS}.`);
  // The build header leads back to the branch.
  await page.getByTestId("branch-link").click();
  await expect(page).toHaveURL(new RegExp(`/branches/${branch}$`));

  // The default branch has no branch page: it is the project page.
  await page.goto(`/projects/${projectId}/branches/main`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
}
