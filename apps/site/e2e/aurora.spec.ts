import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

/*
 * The aurora blobs stay by the text on a wide screen. Each blob hangs off the page's centre line, floored
 * at the old edge offsets, so up to 1024px they sit where they always did and on a 4K screen they do not
 * drift a whole column away from the headline. The home hero and every inner page's art share the rules.
 *
 * Reduced motion, so the drift animation does not move a box between reads. Desktop project only: the
 * viewport is set here with test.use, so the phone emulation would change it.
 */
const REM = 16;
const BLOB = 42 * REM;
const WIDE = [1440, 2560, 3840] as const;
const NARROW = [390, 1024] as const;
// A blob's centre may sit this far (as a share of the column's width) outside the column on each side.
const SLACK = 0.25;

interface Box {
  x: number;
  width: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
}

async function blobs(aurora: Locator): Promise<Box[]> {
  const spans = aurora.locator("span");
  await expect(spans).toHaveCount(3);
  return Promise.all([0, 1, 2].map((i) => box(spans.nth(i))));
}

function expectBeside(blob: Box, column: Box, label: string): void {
  const centre = blob.x + blob.width / 2;
  const slack = column.width * SLACK;
  expect(
    centre,
    `${label}: centre x ${centre} vs column ${column.x}..${column.x + column.width}`,
  ).toBeGreaterThanOrEqual(column.x - slack);
  expect(centre, label).toBeLessThanOrEqual(column.x + column.width + slack);
}

test.use({ reducedMotion: "reduce" });
test.skip(({ isMobile }) => isMobile, "the desktop project only");

for (const width of WIDE) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test("the home hero's blobs sit by the headline column", async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const hero = page
        .locator("section")
        .filter({ has: page.locator("h1") })
        .first();
      const column = await box(hero.locator(".relative.mx-auto.max-w-4xl"));
      const found = await blobs(hero.locator(".home-aurora-hero"));
      found.forEach((blob, i) => expectBeside(blob, column, `home blob ${i + 1}`));
    });

    if (width === 3840)
      test("an inner page's blobs sit by its content column", async ({ page }) => {
        await page.goto("/docs", { waitUntil: "networkidle" });
        const column = await box(page.locator(".page-art > .py-8 > *").first());
        const found = await blobs(page.locator(".page-art-bg .home-aurora"));
        found.forEach((blob, i) => expectBeside(blob, column, `docs blob ${i + 1}`));
      });
  });
}

for (const width of NARROW) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the home hero's blobs are where they always were", async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const aurora = page.locator(".home-aurora-hero");
      const area = await box(aurora);
      const [one, two, three] = await blobs(aurora);
      // left -10rem; right -14rem; left 30%, all against the aurora's own box.
      expect(one?.x).toBeCloseTo(area.x - 10 * REM, 0);
      expect(two?.x).toBeCloseTo(area.x + area.width + 14 * REM - BLOB, 0);
      expect(three?.x).toBeCloseTo(area.x + area.width * 0.3, 0);
    });
  });
}
