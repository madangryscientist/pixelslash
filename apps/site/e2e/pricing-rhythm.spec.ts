import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { box } from "./support/header.ts";

/*
 * /pricing starts and ends at the rhythm of /docs, and its commitment callout lines up (PS-379).
 * Each gap is measured on /pricing and on /docs in the same test, so a change to the shell moves
 * both and the test still compares like with like:
 *   - the gap from the header's bottom edge to the first heading (the h1's box);
 *   - the gap from the bottom of the last content block to the footer's top edge.
 * At desktop the commitment's left edge meets the left edge of a column below it (the facts' third
 * card), within 2px. At 390 nothing scrolls sideways and the order is action, commitment, facts.
 * Both themes, desktop project only (the viewport is set here, so the phone emulation would change it).
 */
const SCHEMES = ["light", "dark"] as const;
const TOLERANCE = 8;

type Gaps = { top: number; bottom: number };

async function gaps(page: Page, path: string): Promise<Gaps> {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const header = await box(page.locator("header").first());
  const heading = await box(page.getByRole("main").locator("h1").first());
  const footer = await box(page.locator("footer").first());
  // The last content block: the page's own container's last child, inside the page-art wrapper.
  const last = await box(page.locator(".page-art > div:not(.page-art-bg) > * > *:last-child"));
  return { top: heading.y - (header.y + header.h), bottom: footer.y - (last.y + last.h) };
}

for (const colorScheme of SCHEMES) {
  test.describe(`at 1440 in ${colorScheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("the first heading and the footer sit as far from the page's edges as on /docs", async ({
      page,
    }) => {
      const docs = await gaps(page, "/docs");
      const pricing = await gaps(page, "/pricing");
      expect(Math.abs(pricing.top - docs.top), "nav to first heading vs /docs").toBeLessThanOrEqual(
        TOLERANCE,
      );
      expect(
        Math.abs(pricing.bottom - docs.bottom),
        "last block to footer vs /docs",
      ).toBeLessThanOrEqual(TOLERANCE);
    });

    test("the commitment's left edge meets a column of the facts below it", async ({ page }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const commitment = await box(page.getByTestId("commitment"));
      const cards = page.getByTestId("pricing-facts").locator(":scope > *");
      const edges: number[] = [];
      for (let i = 0; i < (await cards.count()); i++) {
        const card = await box(cards.nth(i));
        edges.push(card.x, card.x + card.w);
      }
      const nearest = Math.min(
        ...edges.flatMap((edge) => [
          Math.abs(commitment.x - edge),
          Math.abs(commitment.x + commitment.w - edge),
        ]),
      );
      expect(nearest, "commitment edge vs nearest card edge").toBeLessThanOrEqual(2);
      const third = edges[4] ?? Number.NaN;
      expect(Math.abs(commitment.x - third), "left edge vs third card's left").toBeLessThanOrEqual(
        2,
      );
    });
  });

  test.describe(`at 390 in ${colorScheme}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, colorScheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("nothing scrolls sideways and the order is action, commitment, facts", async ({
      page,
    }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, "scrollWidth minus viewport").toBeLessThanOrEqual(0);
      const action = await box(page.getByTestId("pricing-action"));
      const commitment = await box(page.getByTestId("commitment"));
      const facts = await box(page.getByTestId("pricing-facts"));
      expect(commitment.y).toBeGreaterThan(action.y + action.h);
      expect(commitment.y + commitment.h).toBeLessThanOrEqual(facts.y);
    });
  });
}
