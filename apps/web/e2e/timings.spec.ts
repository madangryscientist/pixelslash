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
  await expect(page.getByTestId("build-timings")).toBeVisible();
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
  await expect(row.getByTestId("timings-summary")).toHaveText("—");
  // The tab says what Total covers and leaves out.
  await expect(page.getByRole("region", { name: "Timings" })).toContainText(
    "Total runs from the diff starting",
  );
});

test("with no build the Timings tab says so, not a row of dashes", async ({ page }) => {
  await provision(page, "Quiet Co", "quiet");
  await openTimings(page, "Quiet Co");
  await expect(page.getByTestId("timings-empty")).toContainText(
    "No finished builds in the last 30 days",
  );
  await expect(page.getByTestId("timings-row")).toHaveCount(0);
});

test("with several builds the Timings tab counts them and keeps the slowest as max", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Busy Co", "busy");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const ids: string[] = [];
  for (const letter of ["b", "c", "d"]) {
    ids.push(
      await uploadBuild(
        token,
        {
          branch: `work-${letter}`,
          commitSha: letter.repeat(40),
          mergeBaseSha: SHA_MAIN,
          ancestorShas: [SHA_MAIN],
        },
        [{ name: "hero", png: CHANGED }],
      ),
    );
  }

  await open(page, `/projects/${projectId}/builds/${ids[2]}`);
  await expect(page.getByTestId("timing-server-total")).toContainText("total from diff start");

  await openTimings(page, "Busy Co");
  const row = page.getByTestId("timings-row");
  await expect(row.getByTestId("timings-builds")).toHaveText("4");
  await expect(row.getByTestId("timings-diff-tail")).toHaveText("max");
  await expect(row.getByTestId("timings-queue")).toContainText("max");
});
