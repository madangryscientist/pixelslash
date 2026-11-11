import { type Locator, type Page, expect, test } from "@playwright/test";
import { SHA_MAIN, SHA_WORK, open, provision, uploadBuild } from "./api-upload";
import { png } from "./png";
import { showPanel } from "./snapshot-viewer";

/**
 * The compare view's header and panes (PS-422): on a phone the title has its own row and the bar
 * stays short, each pane's label names its side and stays on screen while a tall shot scrolls, and
 * the side rail's content is beside the image wherever the page is scrolled.
 *
 * The shots are 1300×5000: at Fit, side by side, even with the side panel open, the page is over
 * 1500 px taller than the screen, so there is something to scroll past.
 */

const MAIN = png(1300, 5000);
const BRANCH = png(1300, 5000, [{ x: 100, y: 200, w: 400, h: 200, rgb: [220, 30, 30] }]);

const NAME = "overview-all-themes-in-every-state";

/** A changed tall shot, opened on its compare view. */
async function openTallShot(page: Page) {
  const { token, projectId } = await provision(page, "Header Co", "header");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: NAME, png: MAIN }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: NAME, png: BRANCH }],
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  // The panes are only as tall as their shots once those have loaded.
  await expect
    .poll(() =>
      page.evaluate(() => [...document.images].filter((img) => img.naturalWidth > 0).length),
    )
    .toBe(2);
}

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not drawn");
  return box;
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("a phone gives the title its own row, and the sticky header stays short", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTallShot(page);
  const bar = page.getByTestId("viewer-bar");
  const title = bar.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  const titleBox = await boxOf(title);

  // Every chip and counter, each leaf of the meta row, sits clear of the title.
  const meta = await page.getByTestId("shot-meta").evaluate((el) =>
    [...el.querySelectorAll("*")]
      .filter((node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "")
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { text: node.textContent, x: r.x, y: r.y, width: r.width, height: r.height };
      }),
  );
  expect(meta.length).toBeGreaterThan(3);
  for (const item of meta) {
    expect(overlaps(titleBox, item), `"${item.text}" over the title`).toBe(false);
    // On its own row below the title, not beside it.
    expect(item.y, `"${item.text}" under the title`).toBeGreaterThanOrEqual(
      titleBox.y + titleBox.height - 1,
    );
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // The bar is the sticky element around the viewer bar's content.
  const height = await bar.evaluate((el) => el.parentElement?.getBoundingClientRect().height ?? 0);
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThanOrEqual(128);

  // Still within the limit after the page scrolls: it is the sticky one, and the crumbs are gone.
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(bar).toBeInViewport();
  const stuck = await bar.evaluate((el) => el.parentElement?.getBoundingClientRect().height ?? 0);
  expect(stuck).toBeLessThanOrEqual(128);
});

test("the panes are labelled with their side and stay labelled while a tall shot scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTallShot(page);

  // A snapshot has one theme and one viewport: the header names them once, beside the chips.
  const bar = page.getByTestId("viewer-bar");
  await expect(bar.getByTestId("shot-chip").filter({ hasText: "Light mode" })).toBeVisible();
  await expect(bar.getByTestId("shot-chip").filter({ hasText: "40x40" })).toBeVisible();

  const labels = page.getByTestId("pane-label");
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(0)).toContainText("Main");
  await expect(labels.nth(1)).toContainText("Branch");
  await expect(labels.nth(0)).toContainText("1300×5000");

  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(1400);
  const stickyBottom = await bar.evaluate((el) => el.parentElement?.getBoundingClientRect().bottom);
  for (const label of [labels.nth(0), labels.nth(1)]) {
    await expect(label).toBeInViewport();
    // Under the sticky bar, not hidden behind it.
    const box = await boxOf(label);
    expect(box.y).toBeGreaterThanOrEqual((stickyBottom ?? 0) - 1);
  }
});

test("the side rail's content sticks beside the image wherever the page is scrolled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTallShot(page);
  // At Fit, side by side, the panel folds away behind its toggle: open it first.
  await showPanel(page);
  const rail = page.getByRole("complementary", { name: "Review panel" });
  await expect(rail).toBeVisible();
  const first = rail.locator(":scope > *").first();
  await expect(first).toBeInViewport();

  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(1400);
  await expect(first).toBeInViewport();
  const box = await boxOf(first);
  const stickyBottom = await page
    .getByTestId("viewer-bar")
    .evaluate((el) => el.parentElement?.getBoundingClientRect().bottom ?? 0);
  expect(box.y).toBeGreaterThanOrEqual(stickyBottom - 1);
});
