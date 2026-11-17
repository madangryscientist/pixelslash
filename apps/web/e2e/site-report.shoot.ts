import { readFile } from "node:fs/promises";
import { expect, open, test } from "./fixtures";
import { uploadBuild } from "./api-upload";
import { sql } from "./d1";
import { highlightToggle, showPanel } from "./snapshot-viewer";

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

const CHANGE_BOX = 'svg[aria-label="Measured regions"] rect[data-kind="change"]';

// Fixed, so the page reads the same on every run.
const SHA_MAIN = "4f1c2e9a7b3d5c8e0a1f2b3c4d5e6f7a8b9c0d1e";
const SHA_BRANCH = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";

// The review app's default light theme, at 2x like the site's other images. The width is the
// viewport's; the height is cut to the content below.
const WIDTH = 1280;
test.use({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });

test("the compare view of the changed checkout shot", async ({ page, provision }) => {
  const main = await readFile(env("PIXELSLASH_SITE_REPORT_MAIN"));
  const branch = await readFile(env("PIXELSLASH_SITE_REPORT_BRANCH"));
  const changedPixels = Number(env("PIXELSLASH_SITE_REPORT_CHANGED_PIXELS"));
  const { token, orgId, projectId } = await provision({ project: "checkout" });
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
  // `provision` suffixes the org's name, and the stub's user reads as a test account in the header:
  // name both for the page. This D1 is the run's own.
  sql(
    [
      `UPDATE orgs SET name = 'Acme' WHERE id = '${orgId}'`,
      "UPDATE users SET login = 'jordan-lee', name = 'Jordan Lee' WHERE login = 'e2e-octocat'",
    ].join(";\n"),
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  // The review app's own diff counted what the CLI run did, so report.json describes this page.
  await showPanel(page);
  await expect(page.getByTestId("changed-px")).toHaveText(
    new RegExp(`^${changedPixels.toLocaleString("en-US")} \\(`),
  );
  const panel = page.getByRole("button", { name: "Side panel", exact: true });
  await panel.click();
  await expect(panel).toHaveAttribute("aria-pressed", "false");
  // No hover or focus ring left on it in the shot.
  await page.mouse.move(0, 0);
  await panel.blur();
  // Highlight on, so the measured region is drawn on the shot.
  const highlight = highlightToggle(page);
  await highlight.click();
  await expect(highlight).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('svg[aria-label="Measured regions"]').first()).toBeVisible();
  await page.getByRole("radio", { name: "1:1", exact: true }).click();
  await page.mouse.move(0, 0);
  await highlight.blur();
  await page.getByRole("radio", { name: "1:1", exact: true }).blur();
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
  // Cut to what reads at site size: from the Accept and Reject row (under the badges) down through
  // the panes and the side panel, ending just under the measured change. At 1:1 the shot is drawn
  // at its own size, so the change is legible; Fit would shrink the whole 1280 px page into a pane.
  const top = (await page.getByRole("button", { name: /^Accept/ }).boundingBox())?.y;
  const region = await page.locator(CHANGE_BOX).first().boundingBox();
  if (top === undefined || !region) throw new Error("no Accept button or change box to cut to");
  const clip = {
    x: 0,
    y: top - 10,
    width: WIDTH,
    height: region.y + region.height + 32 - (top - 10),
  };
  // A transition still running (the toggles' colours) would differ from run to run: finish it.
  await page.screenshot({
    path: env("PIXELSLASH_SITE_REPORT_OUT"),
    clip,
    animations: "disabled",
    caret: "hide",
  });
});
