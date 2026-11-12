import { openRunCard } from "./build-workspace";
import { type Page, expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/** Server build timings (ob 1792): the numbers a real diff run stores, on the build page and the org's Timings tab. */

async function openTimings(page: Page, org: string) {
  await open(page, "/orgs");
  await page
    .getByRole("navigation", { name: "Organizations" })
    .getByRole("link", { name: new RegExp(`^${org} \\d+$`) })
    .click();
  await expect(page.getByRole("heading", { name: org, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Timings", exact: true }).click();
  await expect(page).toHaveURL(/tab=timings/);
}

const CLI = { totalMs: 900, captureMs: 400, shots: [] };

test("a diffed build shows its server timings, and the org's Timings tab their p50 and max", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Timings Co", "timed");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
    { timings: CLI },
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await openRunCard(page);
  await expect(page.getByTestId("timing-server-diff")).toHaveText(/diff\s+\d/);
  await expect(page.getByTestId("timing-server-queue")).toBeVisible();
  // The label says what the total leaves out: the wait before the diff is its own step.
  await expect(page.getByTestId("timing-server-total")).toContainText("total from diff start");
  // The first run of a build is not "a re-run of this build".
  await expect(page.getByTestId("timings-server-note")).toHaveCount(0);
  // No model on this project: nothing is claimed for steps that did not run.
  await expect(page.getByTestId("timing-server-explain")).toHaveCount(0);
  await expect(page.getByTestId("timing-server-summary")).toHaveCount(0);
  // The CLI's total is the wall clock, which the line says.
  await expect(page.getByTestId("timing-cli-total")).toBeVisible();
  await expect(page.getByTestId("timings-cli-note")).toContainText("wall-clock");

  await openTimings(page, "Timings Co");
  const row = page.getByTestId("timings-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("timed");
  await expect(row.getByTestId("timings-builds")).toHaveText("2");
  await expect(row.getByTestId("timings-diff")).toHaveText(/\d.* \/ .*\d.*max/);
  await expect(row.getByTestId("timings-diff-tail")).toHaveText("max");
  // Every build with the step is every build: no count beside the figures.
  await expect(row.getByTestId("timings-total-count")).toHaveCount(0);
  await expect(row.getByTestId("timings-summary")).toHaveText("n/a");
  // The tab says what Total covers and leaves out.
  await expect(page.getByRole("region", { name: "Timings" })).toContainText(
    "Total runs from the diff starting",
  );
});

const SETTLE = { fontsMs: 120, imagesMs: 340, networkIdleMs: 5500, framesMs: 40 };

/** What a current CLI sends: the capture's wall and workers, its parts, the requests' spread and the host. */
const PROFILE = {
  totalMs: 21_000,
  browserLaunchMs: 400,
  captureWallMs: 4_200,
  workers: { capture: 4, upload: 4 },
  host: { cores: 16, loadStart: 3.2, loadEnd: 4.1 },
  captureMs: 10_000,
  navigateMs: 1_000,
  settleMs: 7_000,
  screenshotMs: 1_200,
  setupMs: 500,
  storyMs: 600,
  measureMs: 300,
  settle: SETTLE,
  upload: {
    totalMs: 9_000,
    batches: [
      { step: "upload", count: 120, ms: 20_000, p50Ms: 180, p90Ms: 420, maxMs: 900, wallMs: 3_200 },
      {
        step: "finalize",
        count: 1,
        ms: 9_500,
        p50Ms: 9_500,
        p90Ms: 9_500,
        maxMs: 9_500,
        wallMs: 9_500,
      },
    ],
  },
  shots: [{ name: "hero", captureMs: 10_000, navigateMs: 1_000, settleMs: 7_000, settle: SETTLE }],
};

test("a build shows the CLI's full speed profile in both themes, at desktop and phone width", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Profile Co", "profiled");
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK },
    [{ name: "hero", png: WHITE }],
    { timings: PROFILE },
  );
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize(viewport);
      await open(page, `/projects/${projectId}/builds/${buildId}`);
      await openRunCard(page);
      const where = `${colorScheme} at ${viewport.width}`;
      await expect(page.getByTestId("profile-capture-wall-text"), where).toHaveText(
        /^4\.2.s against 10.s of worker time, on 4 workers$/,
      );
      const parts = page.getByTestId("profile-capture-parts-text");
      await expect(parts, where).toContainText("settle 70% (");
      await expect(parts, where).toContainText("network idle 55%");
      await expect(page.getByTestId("profile-requests-upload-text"), where).toHaveText(
        /p50 180.ms, p90 420.ms, max 900.ms/,
      );
      await expect(page.getByTestId("profile-requests-finalize-text"), where).toContainText("p90");
      await expect(page.getByTestId("profile-host-text"), where).toHaveText(
        "16 cores, load 3.2 at the start and 4.1 at the end",
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, where).toBeLessThanOrEqual(0);
    }
  }
});

test("a build from an older CLI shows its steps and no profile", async ({ page }) => {
  const { token, projectId } = await provision(page, "Older Co", "older");
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK },
    [{ name: "hero", png: WHITE }],
    { timings: CLI },
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await openRunCard(page);
  await expect(page.getByTestId("timing-cli-capture")).toBeVisible();
  await expect(page.locator("[data-testid^='profile-']")).toHaveCount(0);
});

test("with no build the Timings tab says so, not a row of dashes", async ({ page }) => {
  await provision(page, "Quiet Co", "quiet");
  await openTimings(page, "Quiet Co");
  await expect(page.getByTestId("timings-empty")).toContainText(
    "No finished builds in the last 30 days",
  );
  await expect(page.getByTestId("timings-row")).toHaveCount(0);
});
