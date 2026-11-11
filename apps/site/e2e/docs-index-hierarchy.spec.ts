import { expect, test } from "@playwright/test";
import { GROUPS } from "../src/content/docs-map.ts";

/*
 * PS-378: the /docs landing has a hierarchy. A group heading is larger and heavier than the links
 * under it, Get started is the first group, spans the row and starts above the fold, an odd tail
 * spans its row so the grid ends evenly, and the intro is held to 75ch. That every listed page is
 * still linked stays with smoke.spec.ts and docs.test.tsx. Desktop, 1440x900, both themes.
 */

for (const scheme of ["light", "dark"] as const) {
  test.describe(`the landing hierarchy at 1440 in ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    // PS-378: a group heading is stronger than the links under it, measured, not assumed.
    test("each group heading is larger than every link in its card", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      for (const [index, group] of GROUPS.entries()) {
        const card = cards.nth(index);
        const heading = await card.locator("h2").evaluate((el) => {
          const style = getComputedStyle(el);
          return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) };
        });
        const links = await card
          .locator("a[href^='/docs/']")
          .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
        expect(links.length, `${group.id}: has links`).toBeGreaterThan(0);
        for (const size of links)
          expect(heading.size, `${group.id}: heading against a link`).toBeGreaterThan(size);
        expect(heading.weight, `${group.id}: heading weight`).toBeGreaterThanOrEqual(600);
      }
    });

    test("Get started is the first group, spans the row and starts above the fold", async ({
      page,
    }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      await expect(cards.first().locator("h2")).toHaveText(GROUPS[0].title);
      const heading = await cards.first().locator("h2").boundingBox();
      if (!heading) throw new Error("the Get started heading has no box");
      expect(heading.y, "heading top is above the fold").toBeLessThan(900);
      // It spans both columns: as wide as the list, and wider than a later, two-up group.
      const [list, first, second] = await Promise.all([
        page.getByTestId("docs-index").boundingBox(),
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
      ]);
      if (!list || !first || !second) throw new Error("a group has no box");
      expect(first.width).toBeGreaterThanOrEqual(list.width - 1);
      expect(second.width).toBeLessThan(list.width * 0.6);
    });

    test("an odd tail spans the row, so the grid ends evenly", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      const [list, last] = await Promise.all([
        page.getByTestId("docs-index").boundingBox(),
        cards.last().boundingBox(),
      ]);
      if (!list || !last) throw new Error("the list or its last group has no box");
      // Get started spans the first row, so an odd count after it leaves the last group alone in its row.
      const alone = (GROUPS.length - 1) % 2 === 1;
      if (alone)
        expect(last.width, "a lone last group spans the row").toBeGreaterThanOrEqual(
          list.width - 1,
        );
      else expect(last.width, "a paired last group shares its row").toBeLessThan(list.width * 0.6);
    });

    test("the intro is held to 75ch", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const intro = page.getByTestId("docs-intro");
      const [width, ch75] = await intro.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:75ch;visibility:hidden";
        el.append(probe);
        const measured = probe.getBoundingClientRect().width;
        probe.remove();
        return [el.getBoundingClientRect().width, measured];
      });
      expect(width, "intro width against 75ch").toBeLessThanOrEqual(ch75 + 1);
    });
  });
}
