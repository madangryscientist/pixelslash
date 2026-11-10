import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { box, hydrated } from "./support/header.ts";

/*
 * Every page's wide blocks sit on the header's column (PS-361). L is the left edge of the brand link,
 * the first link in the header; R is the right edge of the last link or button in it that shows. A
 * block is held to them by its border box, within 1px, at the two desktop widths. Light theme only,
 * since the scheme does not change the layout.
 */
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
] as const;
const TOLERANCE = 1;

async function column(page: Page): Promise<{ left: number; right: number }> {
  const header = page.locator("header").first();
  const brand = await box(header.locator("a").first());
  const shown = header.locator("a:visible, button:visible");
  const last = await box(shown.last());
  return { left: brand.x, right: last.x + last.w };
}

async function open(page: Page, path: string): Promise<{ left: number; right: number }> {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await hydrated(page);
  return column(page);
}

for (const viewport of WIDTHS) {
  test.describe(`at ${viewport.width} in light`, () => {
    test.use({ viewport, colorScheme: "light" });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("/pricing: the facts run from the header's left to its right, the commitment ends at its right", async ({
      page,
    }) => {
      const { left, right } = await open(page, "/pricing");
      const facts = await box(page.getByTestId("pricing-facts"));
      expect(Math.abs(facts.x - left), "pricing-facts left").toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(facts.x + facts.w - right), "pricing-facts right").toBeLessThanOrEqual(
        TOLERANCE,
      );
      // The commitment sits beside the headline now, so only its right edge is on the column.
      const commitment = await box(page.getByTestId("commitment"));
      expect(commitment.x, "commitment left is inside the column").toBeGreaterThan(left);
      expect(Math.abs(commitment.x + commitment.w - right), "commitment right").toBeLessThanOrEqual(
        TOLERANCE,
      );
    });

    test("/docs: the search box and the index cards run from the header's left to its right (no rail)", async ({
      page,
    }) => {
      const { left, right } = await open(page, "/docs");
      const search = await box(page.getByTestId("docs-search"));
      expect(Math.abs(search.x - left), "search left").toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(search.x + search.w - right), "search right").toBeLessThanOrEqual(TOLERANCE);
      const found = await box(page.getByTestId("docs-index"));
      expect(Math.abs(found.x - left), "docs-index left").toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(found.x + found.w - right), "docs-index right").toBeLessThanOrEqual(
        TOLERANCE,
      );
    });

    test("/: the features, the install and the local band run from the header's left to its right", async ({
      page,
    }) => {
      const { left, right } = await open(page, "/");
      const columns = page.getByTestId("home-column");
      await expect(columns).toHaveCount(3);
      for (let index = 0; index < 3; index += 1) {
        const found = await box(columns.nth(index));
        expect(Math.abs(found.x - left), `column ${index} left`).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(found.x + found.w - right), `column ${index} right`).toBeLessThanOrEqual(
          TOLERANCE,
        );
      }
    });
  });
}
