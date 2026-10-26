import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/**
 * Flakes on the server (ob 1724): a flaky shot under each policy, uploaded as the CLI sends it,
 * gets its badge and the build's summary line; the policy control copies a config line; the
 * Flakes list resolves and reopens. The uploads go straight to the API: the CLI's re-capture
 * needs a browser, and what the server stores is the same form either way.
 */

test("a flaky shot under each policy: badge, summary line, config line, resolve and reopen", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { token, projectId } = await provision(page);
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
      { name: "hero", png: CHANGED, flaky: "review" },
      { name: "ticker", png: CHANGED, flaky: "skip" },
    ],
  );

  // The project page: the review-policy shot waits; the skipped one is counted on its own line.
  await open(page, `/projects/${projectId}`);
  const row = page.getByTestId("build-row").first();
  await expect(row.getByTestId("to-review")).toHaveText("1 to review");
  await expect(row.getByTestId("skipped-flaky-count")).toHaveText("1 skipped: flaky");

  // The build page: both cards badged, the header's line, and the build still waits on review.
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("skipped-flaky-count")).toHaveText("1 skipped: flaky");
  const badges = page.getByTestId("flaky-badge");
  await expect(badges).toHaveCount(2);
  await expect(badges.filter({ hasText: "skipped: flaky" })).toHaveCount(1);
  await expect(badges.filter({ hasText: /^flaky$/ })).toHaveCount(1);
  await expect(page.getByTestId("build-status")).toHaveText("changes");

  // The skipped shot's panel: the runs side by side, how many differed, the policy in effect.
  await page
    .getByRole("link", { name: /ticker/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const panel = page.getByTestId("flake-panel");
  await expect(panel.getByTestId("flaky-badge")).toHaveText("skipped: flaky");
  await expect(panel.getByTestId("flake-differed")).toHaveText("1 of 3 runs differed (run 2)");
  await expect(panel.getByTestId("flake-run")).toHaveCount(3);
  await expect(panel.locator('[data-testid="flake-run"][data-differed="true"]')).toHaveCount(1);
  await expect(panel.getByTestId("flaky-policy")).toContainText("skip: it does not wait");

  // The policy control offers the other policy and copies its line; nothing changes on the server.
  const control = panel.getByTestId("flaky-policy-control");
  await expect(control.getByTestId("flaky-route-line").locator("code")).toHaveText(
    '"flaky": "review"',
  );
  await expect(control.getByTestId("flaky-story-tag").locator("code")).toHaveText(
    "pixelslash-flaky-review",
  );
  await expect(control).toContainText("takes effect from the next build");
  await control.getByRole("button", { name: "copy" }).first().click();
  await expect(control.getByRole("button", { name: "copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"flaky": "review"');

  // The Flakes list: both open; resolve one with a note, then reopen it.
  await panel.getByTestId("flaky-badge").click();
  await expect(page).toHaveURL(/\/flakes#flake-/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const flakes = page.getByTestId("flake");
  await expect(flakes).toHaveCount(2);
  const ticker = flakes.filter({ hasText: "ticker" });
  await expect(ticker).toHaveAttribute("data-status", "open");
  await expect(ticker.getByTestId("flake-differed")).toHaveText("1 of 3 runs differed (run 2)");
  await ticker.getByRole("button", { name: "Resolve" }).click();
  await ticker.getByLabel("Resolution note (optional)").fill("froze the ticker");
  await ticker.getByRole("button", { name: "Resolve" }).click();
  await expect(ticker).toHaveAttribute("data-status", "resolved");
  await expect(ticker.getByTestId("flake-resolution")).toContainText("by e2e-octocat");
  await expect(ticker.getByTestId("flake-resolution")).toContainText("froze the ticker");
  // Open flakes first: the resolved one moves below the open one.
  await expect(flakes.first()).toContainText("hero");
  await ticker.getByRole("button", { name: "Reopen" }).click();
  await expect(ticker).toHaveAttribute("data-status", "open");
});
