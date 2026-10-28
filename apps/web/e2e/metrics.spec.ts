import { type Page, expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { openSection } from "./snapshot-viewer";
import { sql } from "./d1";

/**
 * Metrics in the review UI (PS-233): the build page's "This run" card, the shot page's compare
 * time and the branch page's window. A build older than the timings is made by clearing them in
 * D1: an upload today always records them.
 */

const WORK = { branch: "work", mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] };

async function openShot(page: Page, name: string) {
  await page
    .getByTestId("snapshot-row")
    .filter({ hasText: name })
    .getByRole("link")
    .first()
    .click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await openSection(page, "Details");
  await expect(page.getByTestId("measured-by")).toBeVisible();
}

test("a diffed build states its wall time, counts and compare time, and the branch its window", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Metrics Co", "metrics");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
  ]);
  const buildId = await uploadBuild(token, { ...WORK, commitSha: SHA_WORK }, [
    { name: "hero", png: CHANGED },
    { name: "ticker", png: WHITE },
  ]);

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  const card = page.getByTestId("build-timings");
  await expect(card.getByTestId("run-wall-value")).toHaveText(/\d/);
  await expect(card.getByTestId("run-wall-source")).toContainText("derived");
  await expect(card.getByTestId("run-shots-value")).toHaveText("2");
  await expect(card.getByTestId("run-compares-value")).toHaveText("2");
  await expect(card.getByTestId("run-unmeasured-value")).toHaveText("0");
  await expect(card.getByTestId("run-compare-value")).toContainText("(n = 2)");
  await expect(card.getByTestId("run-compare-source")).toContainText("stored by the server");
  // A feature branch is never auto-accepted, the CLI sent no re-captures, no model ran.
  await expect(card.getByTestId("run-auto-accepted")).toHaveCount(0);
  await expect(card.getByTestId("run-recaptures")).toHaveCount(0);
  await expect(card.getByTestId("run-tokens-explain")).toHaveCount(0);
  await expect(card.getByTestId("run-no-timings")).toHaveCount(0);

  await openShot(page, "hero");
  await expect(page.getByTestId("compare-time")).toHaveText(/\d/);

  await open(page, `/projects/${projectId}/branches/work`);
  const metrics = page.getByTestId("branch-metrics");
  await expect(metrics.getByTestId("branch-metrics-window")).toContainText(
    "Over the branch's last 20 builds: 1 build here.",
  );
  await expect(metrics.getByTestId("branch-metrics-wall")).toContainText("(n = 1 finished build)");
  await expect(metrics.getByTestId("branch-metrics-compare-time")).toContainText("(n = 2 shots)");
  // One build is a value, not a trend.
  await expect(metrics.getByTestId("branch-metrics-sparkline")).toHaveCount(0);
});

test("a build older than the timings says so, and invents no zero", async ({ page }) => {
  const { token, projectId } = await provision(page, "Old Co", "old");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const buildId = await uploadBuild(token, { ...WORK, commitSha: SHA_WORK }, [
    { name: "hero", png: CHANGED },
  ]);
  // What a build stored before ob 1792 and PS-233 has: no step times and no per-shot compare time.
  sql(
    "UPDATE builds SET finished_at = NULL, queue_ms = NULL, diff_ms = NULL, explain_ms = NULL, " +
      `summary_ms = NULL WHERE id = '${buildId}'`,
  );
  sql(`UPDATE snapshots SET diff_ms = NULL WHERE build_id = '${buildId}'`);

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  const card = page.getByTestId("build-timings");
  await expect(card.getByTestId("run-no-timings")).toContainText("No run timings were recorded");
  await expect(card.getByTestId("run-wall")).toHaveCount(0);
  await expect(card.getByTestId("run-compare")).toHaveCount(0);
  await expect(card.getByTestId("timings-server")).toHaveCount(0);
  // The counts are still what the stored shots say.
  await expect(card.getByTestId("run-shots-value")).toHaveText("1");
  await expect(card).not.toContainText(/(^|\D)0\s?ms\b/);

  await openShot(page, "hero");
  await expect(page.getByTestId("compare-time")).toHaveCount(0);

  await open(page, `/projects/${projectId}/branches/work`);
  const metrics = page.getByTestId("branch-metrics");
  await expect(metrics.getByTestId("branch-metrics-builds")).toHaveText("1");
  await expect(metrics.getByTestId("branch-metrics-wall")).toHaveCount(0);
  await expect(metrics.getByTestId("branch-metrics-compare-time")).toHaveCount(0);
});
