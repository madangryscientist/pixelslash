import { type Page, expect, test } from "@playwright/test";
import { SHA_MAIN, SHA_WORK, open, provision, uploadBuild } from "./api-upload";
import { openRunCard } from "./build-workspace";
import { sql } from "./d1";
import { png } from "./png";

/**
 * The build page puts the work first (PS-419): the changed shots come before the run's diagnostics,
 * which are folded; the AI summary is a short lead whose links never wrap mid-label and never make
 * a wall; a thumbnail of a tall page is a readable 16:10 box; and a phone has no sideways scroll.
 *
 * Twelve changed shots, each a tall page with a thin wide change, so the thumbnails are the
 * sliver case. The model is not involved: the stored summary is written straight to the build.
 */

const SHOTS = 12;
// The last has a long name, which a summary link must cut rather than widen a phone's page.
const LONG = "a-very-long-component-name-for-one-shot-that-keeps-going-and-going-and-going";
const NAMES = Array.from({ length: SHOTS }, (_, i) =>
  i === SHOTS - 1 ? LONG : `page-${String(i + 1).padStart(2, "0")}`,
);
const MAIN = png(400, 1600);
// A thin, wide change deep in the page: a strip of red on a tall shot.
const BRANCH = png(400, 1600, [{ x: 0, y: 800, w: 400, h: 6, rgb: [220, 30, 30] }]);

const sentence = (text: string, shots: string[]) => ({ text, shots });

/** A build of twelve changed tall shots, and an AI summary stored on it that names them. */
async function seed(page: Page) {
  const { token, projectId } = await provision(page, "Build Page Co", "buildpage");
  await uploadBuild(
    token,
    { branch: "main", commitSha: SHA_MAIN },
    NAMES.map((name) => ({ name, png: MAIN })),
  );
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    NAMES.map((name) => ({ name, png: BRANCH })),
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  const hrefs = await page
    .getByTestId("snapshot-row")
    .getByRole("link")
    .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
  const ids = hrefs.map((href) => href.split("/").pop() ?? "");
  expect(ids).toHaveLength(SHOTS);
  const summary = {
    model: "e2e-model",
    at: Date.now(),
    sentences: [
      sentence("Every page moved a thin strip down the middle.", ids),
      sentence("The first page is the clearest case.", ids.slice(0, 1)),
      sentence("The second page matches it.", ids.slice(1, 2)),
      sentence("The third page matches it too.", ids.slice(2, 3)),
      sentence("The fourth page is the same again.", ids.slice(3, 4)),
    ],
  };
  sql(`UPDATE builds SET ai_summary = '${JSON.stringify(summary)}' WHERE id = '${buildId}'`);
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("summary-sentence").first()).toBeVisible();
}

const scrollOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("the changes come first, the run is folded, the summary is a lead and the thumbnails are 16:10", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page);

  // The first changed shot is above "This run" in the DOM, and on the first screen.
  const first = page.getByTestId("snapshot-row").first();
  await expect(first).toBeInViewport();
  const before = await first.evaluate((row) => {
    const run = document.querySelector('[data-testid="run-disclosure"]');
    if (!run) throw new Error("no run block");
    return (run.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  });
  expect(before, "the first changed shot precedes the run block").toBe(true);

  // "This run" is folded on load, and opens on a click.
  const run = page.getByTestId("run-disclosure").getByRole("button", { name: "This run" });
  await expect(run).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("build-timings")).toBeHidden();
  await openRunCard(page);
  await expect(run).toHaveAttribute("aria-expanded", "true");

  // The summary is three sentences with a toggle for the rest, and the first has 8 links, then "+4 more".
  const sentences = page.getByTestId("summary-sentence");
  await expect(sentences).toHaveCount(3);
  await expect(sentences.first().getByTestId("summary-shot-link")).toHaveCount(8);
  await expect(sentences.first().getByTestId("summary-more-links")).toHaveText("+4 more");
  await sentences.first().getByTestId("summary-more-links").click();
  await expect(sentences.first().getByTestId("summary-shot-link")).toHaveCount(12);
  await expect(sentences.first().getByTestId("summary-more-links")).toHaveCount(0);
  await page.getByTestId("summary-show-all").click();
  await expect(sentences).toHaveCount(5);
  await expect(page.getByTestId("summary-show-all")).toHaveCount(0);

  // A link's label is one line: no pill breaks across lines.
  for (const link of await page.getByTestId("summary-shot-link").all()) {
    const { height, line } = await link.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(height).toBeLessThanOrEqual(line + 8);
  }

  // Every thumbnail is 16:10, the thin strip on a tall page included.
  const thumbs = page.getByTestId("shot-thumb");
  await expect(thumbs).toHaveCount(SHOTS);
  for (const thumb of await thumbs.all()) {
    const box = await thumb.boundingBox();
    if (!box) throw new Error("a thumbnail is not drawn");
    expect(box.width / box.height).toBeGreaterThan(1.55);
    expect(box.width / box.height).toBeLessThan(1.65);
  }
});

test("a phone has no sideways scroll, with the run card closed or open, and the progress fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  expect(await scrollOverflow(page)).toBeLessThanOrEqual(0);

  // "N of M reviewed" is one line, and the buttons are on screen.
  const progress = page.getByTestId("review-progress").getByText(/of 12 reviewed/);
  const line = await progress.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const box = await progress.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(line * 1.5);
  for (const control of [
    page.getByTestId("review-next"),
    page.getByRole("button", { name: "Accept all" }),
  ]) {
    const at = await control.boundingBox();
    expect(at?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((at?.x ?? 0) + (at?.width ?? 0)).toBeLessThanOrEqual(390);
  }

  // The summary opened out, and the run card opened.
  await page.getByTestId("summary-show-all").click();
  await page.getByTestId("summary-more-links").first().click();
  await page.getByTestId("run-disclosure").scrollIntoViewIfNeeded();
  await openRunCard(page);
  expect(await scrollOverflow(page)).toBeLessThanOrEqual(0);
});
