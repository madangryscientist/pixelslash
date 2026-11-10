import { expect, test } from "@playwright/test";
import { box } from "./support/header.ts";

/*
 * The pricing page opens on a hero (PS-363): the headline, its lead and the action on the left, the
 * commitment beside them on the right, and no heading left over for the contact line. At desktop the
 * commitment starts level with the headline and clear of the lead, and the lead is not jammed under the
 * h1. At a phone the order is the DOM's: action, commitment, facts, with nothing scrolling sideways.
 * Both themes, desktop project only (the viewport is set here, so the phone emulation would change it).
 */
const SCHEMES = ["light", "dark"] as const;

for (const colorScheme of SCHEMES) {
  test.describe(`at 1440 in ${colorScheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("the commitment sits beside the headline, the lead has room, no Questions heading", async ({
      page,
    }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const main = page.getByRole("main");
      const h1 = await box(main.locator("h1"));
      const lead = await box(main.locator("h1").locator("xpath=following-sibling::*[1]"));
      const commitment = await box(page.getByTestId("commitment"));

      expect(Math.abs(commitment.y - h1.y), "commitment top vs h1 top").toBeLessThanOrEqual(24);
      expect(commitment.x, "commitment left vs lead right").toBeGreaterThan(lead.x + lead.w);
      expect(lead.y - (h1.y + h1.h), "h1 bottom to lead top").toBeGreaterThanOrEqual(16);
      await expect(main.getByRole("heading", { name: "Questions" })).toHaveCount(0);
      await expect(main.locator('a[href^="mailto:"]')).toHaveCount(1);
    });
  });

  test.describe(`at 390 in ${colorScheme}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, colorScheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("the commitment follows the action and precedes the facts, and nothing scrolls sideways", async ({
      page,
    }) => {
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const action = await box(page.getByTestId("pricing-action"));
      const commitment = await box(page.getByTestId("commitment"));
      const facts = await box(page.getByTestId("pricing-facts"));
      expect(commitment.y, "commitment below the action").toBeGreaterThan(action.y + action.h);
      expect(commitment.y + commitment.h, "commitment above the facts").toBeLessThanOrEqual(
        facts.y,
      );
      // DOM order: the document's own order of these three, not their painted positions.
      const order = await page.evaluate(() =>
        [...document.querySelectorAll("[data-testid]")]
          .map((el) => el.getAttribute("data-testid"))
          .filter((id) => id === "pricing-action" || id === "commitment" || id === "pricing-facts"),
      );
      expect(order).toEqual(["pricing-action", "commitment", "pricing-facts"]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, "scrollWidth minus viewport").toBeLessThanOrEqual(0);
    });
  });
}
