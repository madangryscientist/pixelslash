import { expect, test } from "@playwright/test";
import { FACTS, LICENCE_BRIEF } from "../src/content/pricing.ts";

/*
 * PS-386: the three fact cards are even, and the licence's clauses sit once, word for word, in a
 * callout after them. The height check measures the text of each card's body (a Range over the bare
 * text node after the heading), not the card box: CardGrid stretches the boxes, so a box check would
 * prove nothing. Both themes at 1440 by 900, desktop project only.
 */
for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`at 1440 in ${colorScheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("the three fact cards' body text is within one line of even", async ({ page }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const measured = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="pricing-facts"] section')].map((card) => {
          const node = card.lastChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("no body text node");
          const range = document.createRange();
          range.selectNodeContents(node);
          const parent = node.parentElement;
          if (!parent) throw new Error("no parent");
          return {
            height: range.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(parent).lineHeight),
          };
        }),
      );
      expect(measured).toHaveLength(FACTS.length);
      const heights = measured.map((m) => m.height);
      const line = measured[0]?.lineHeight ?? Number.NaN;
      expect(line, "a numeric line height").toBeGreaterThan(0);
      expect(
        Math.max(...heights) - Math.min(...heights),
        `body text heights ${heights.join(", ")} px, line ${line} px`,
      ).toBeLessThanOrEqual(line + 0.5);
    });

    test("the licence callout follows the cards and holds the clauses once", async ({ page }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      const main = page.getByRole("main");
      const callout = main.getByTestId("licence-brief");
      await expect(callout).toContainText("The licence in brief");
      await expect(main.getByTestId("licence-brief-text")).toHaveText(LICENCE_BRIEF);
      const text = (await main.innerText()).replace(/\s+/g, " ");
      for (const sentence of LICENCE_BRIEF.split(/(?<=\.) /)) {
        expect(text.split(sentence).length - 1, sentence).toBe(1);
      }
      const facts = await main.getByTestId("pricing-facts").boundingBox();
      const brief = await callout.boundingBox();
      const contact = await main.getByText("Questions?").boundingBox();
      if (!facts || !brief || !contact) throw new Error("a block did not lay out");
      expect(brief.y).toBeGreaterThanOrEqual(facts.y + facts.height);
      expect(brief.y + brief.height).toBeLessThanOrEqual(contact.y);
    });

    test("the callout links to LICENSE in the repository, in the same tab", async ({ page }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      const link = page
        .getByTestId("licence-brief")
        .getByRole("link", { name: "Read the licence" });
      await expect(link).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/[^/]+\/pixelslash\/blob\/main\/LICENSE$/,
      );
      await expect(link).not.toHaveAttribute("target", "_blank");
    });
  });
}
