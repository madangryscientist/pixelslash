import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { sql } from "./d1";

/**
 * Partial re-runs (ob 1738): an errored shot of a server-diff build is measured again from the
 * build page, and only it. The error is put in D1 by hand: a real one (a baseline R2 lost for a
 * moment, a diff that threw) cannot be made to happen on demand against a local build.
 */

test("an errored shot is re-run from the build page, and the build gets its verdict", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Rerun Co", "rerun");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
  ]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [
      { name: "hero", png: CHANGED },
      { name: "ticker", png: WHITE },
    ],
  );
  // What a diff that threw on one shot leaves: that shot unmeasured with its reason, the build errored.
  const reason = "baseline builds/x/hero.png is missing from storage";
  sql(
    `UPDATE snapshots SET diff_status = NULL, diff_result = NULL, diff_error = '${reason}' ` +
      `WHERE build_id = '${buildId}' AND name = 'hero'`,
  );
  sql(
    `UPDATE builds SET status = 'errored', error = '1 of 2 shots could not be measured; ` +
      `re-run them from the build page. hero (40x40, light): ${reason}' WHERE id = '${buildId}'`,
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("errored");
  await expect(page.getByTestId("rerun-ci")).toHaveCount(0);
  await page.getByTestId("rerun-errored").click();
  await expect(page.getByTestId("build-status")).toHaveText("changes");
  await expect(page.getByTestId("rerun-errored")).toHaveCount(0);
  await expect(page.getByText("could not be measured")).toHaveCount(0);
  await expect(page.getByTestId("to-review")).toHaveText(/1 to review/);
});
