import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/**
 * A branch build held open by differences from main shows them (PS-285). Shots that read "no
 * change" against the branch's previous build, yet still differ from main and were never accepted,
 * are carried from main (PS-284): the page lists them under Changed and New, not Unchanged.
 */

const SHA_NEXT = "c".repeat(40);

test("a build held open by differences from main shows them as changed and new", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Carry Co", "carry");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "home", png: WHITE },
    { name: "about", png: WHITE },
    { name: "faq", png: WHITE },
  ]);
  const feat = [
    { name: "home", png: WHITE },
    { name: "about", png: CHANGED },
    { name: "pricing", png: CHANGED },
  ];
  await page.waitForTimeout(1100);
  await uploadBuild(
    token,
    { branch: "feat", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    feat,
  );
  await page.waitForTimeout(1100);
  // The same shots again: nothing changed since the last build, and the first was never accepted.
  const buildId = await uploadBuild(
    token,
    {
      branch: "feat",
      commitSha: SHA_NEXT,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_WORK, SHA_MAIN],
    },
    feat,
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("changes");
  await expect(page.getByTestId("tab-changed")).toContainText("1");
  await expect(page.getByTestId("tab-new")).toContainText("1");
  await expect(page.getByTestId("tab-unchanged")).toContainText("1");
  const counts = page.getByTestId("summary-counts");
  await expect(counts).toContainText("1 changed and 1 new carried from main");
  await expect(counts).not.toContainText("Nothing changed");

  // The j/k walk visits them first, in the order of the tabs: Changed, then New, then the rest.
  await page.getByTestId("group-changed").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const title = page.locator("h1");
  await expect(page.getByTestId("position")).toHaveText("1 of 3");
  await expect(title).toHaveAttribute("title", "about");
  await page.keyboard.press("j");
  await expect(page.getByTestId("position")).toHaveText("2 of 3");
  await expect(title).toHaveAttribute("title", "pricing");
});
