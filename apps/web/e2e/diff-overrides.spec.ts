import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { openSection } from "./snapshot-viewer";

/**
 * Diff thresholds set in the review UI (ob 1495): an override saved from the snapshot screen
 * re-diffs the open build at once, the screen says where the value came from, and the project's
 * settings export it as config.
 */

test("an override set on the snapshot screen flips the verdict and exports as config", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Override Co", "overrides");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("changes");
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await openSection(page, "Tools");
  await expect(page.getByTestId("diff-override")).toBeVisible();
  await expect(page.getByTestId("option-minChangedPixels")).toHaveText("engine default");

  // The change is 10x10 = 100 px: a floor of 200 makes it unchanged, and the build passes.
  await page.getByTestId("override-scope-variant").click();
  await page.getByTestId("override-minChangedPixels").fill("200");
  await page.getByTestId("override-save").click();
  await expect(page.getByTestId("override-note")).toHaveText(
    "Saved. Re-diffed 1 shot; the build is passed.",
  );
  await expect(page.getByTestId("option-minChangedPixels")).toHaveText("200");
  await expect(page.getByTestId("source-minChangedPixels")).toContainText(
    "set in the UI by @e2e-octocat",
  );
  await expect(page.getByTestId("source-minChangedPixels")).toContainText(
    "(this test, this variant); config says engine default",
  );
  await expect(page.getByTestId("override-snippet")).toContainText('"chromium-40x40-light"');

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  await expect(page.getByTestId("override-change")).toHaveCount(1);

  await open(page, `/projects/${projectId}/settings`);
  await expect(page.getByTestId("override-row")).toHaveCount(1);
  await page
    .getByTestId("override-export")
    .getByRole("button", { name: "Export as config" })
    .click();
  const exported = JSON.parse((await page.getByTestId("override-export-json").textContent()) ?? "");
  expect(exported).toEqual({
    variants: [
      {
        name: "chromium-40x40-light",
        browser: "chromium",
        viewport: { width: 40, height: 40 },
        theme: "light",
      },
    ],
    routes: [
      { name: "hero", variants: { "chromium-40x40-light": { diff: { minChangedPixels: 200 } } } },
    ],
  });
});
