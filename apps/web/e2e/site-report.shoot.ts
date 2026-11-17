import { readFile } from "node:fs/promises";
import { expect, open, test } from "./fixtures";
import { uploadBuild } from "./api-upload";
import { sql } from "./d1";
import { highlightToggle } from "./snapshot-viewer";

/**
 * The review app's compare view of one changed shot, saved as the site's `report.png`. The shots are
 * the CLI's own of `fixtures/pages/live.html` (Main) and `local.html` (Branch), so the page shows the
 * run `report.json` describes. `apps/site/scripts/report.ts` runs this through `playwright.site-report.config.ts`
 * and names the files in the env.
 */

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run apps/site/scripts/report.ts`);
  return value;
};

// Fixed, so the page reads the same on every run.
const SHA_MAIN = "4f1c2e9a7b3d5c8e0a1f2b3c4d5e6f7a8b9c0d1e";
const SHA_BRANCH = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";

// 1280x800 in the review app's default light theme, at 2x like the site's other images.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });

test("the compare view of the changed checkout shot", async ({ page, provision }) => {
  const main = await readFile(env("PIXELSLASH_SITE_REPORT_MAIN"));
  const branch = await readFile(env("PIXELSLASH_SITE_REPORT_BRANCH"));
  const { token, projectId } = await provision({ org: "Acme", project: "checkout", exact: true });
  const viewport = "1280x720";
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "cart", png: main, viewport },
  ]);
  const buildId = await uploadBuild(
    token,
    {
      branch: "feat/promo-code",
      commitSha: SHA_BRANCH,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
    },
    [{ name: "cart", png: branch, viewport }],
  );
  // The stub's user reads as a test account in the header; this D1 is the run's own.
  sql("UPDATE users SET login = 'jordan-lee', name = 'Jordan Lee' WHERE login = 'e2e-octocat'");
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  // Highlight on, so the measured region is drawn on the shot.
  await highlightToggle(page).click();
  await expect(page.locator('svg[aria-label="Measured regions"]').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Both panes' pictures drawn, not just their frames.
  const images = page.locator("main img");
  await expect(images.first()).toBeVisible();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("main img")].every(
      (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
    ),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: env("PIXELSLASH_SITE_REPORT_OUT") });
});
