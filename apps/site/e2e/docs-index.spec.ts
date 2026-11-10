import { expect, test } from "@playwright/test";
import { GROUPS } from "../src/content/docs-map.ts";

/*
 * PS-365: the /docs landing has a hierarchy. Each group card's title is a real heading, apart in
 * colour from its summary; the links inside are body ink with a chevron at rest and the link
 * colour on hover and keyboard focus; and the rail drops its group tree on this page only, since
 * the landing is the tree. Run on the desktop project at 1440x900, in both themes.
 */

const GROUP_TESTID = '[data-testid^="docs-group-"]';

for (const scheme of ["light", "dark"] as const) {
  test.describe(`at 1440 in ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    test("each group card has an h2 that differs in colour from its summary", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      await expect(cards).toHaveCount(GROUPS.length);
      for (const [index, group] of GROUPS.entries()) {
        const card = cards.nth(index);
        const heading = card.locator("h2");
        await expect(heading, group.id).toHaveText(group.title);
        const summary = card.locator("p", { hasText: group.summary });
        const [h2, p] = await Promise.all([
          heading.evaluate((el) => getComputedStyle(el).color),
          summary.evaluate((el) => getComputedStyle(el).color),
        ]);
        expect(h2, `${group.id}: h2 against its summary`).not.toBe(p);
      }
    });

    test("the rail has no group tree on /docs, and keeps all twelve on a docs page", async ({
      page,
    }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const nav = page.getByTestId("docs-nav");
      await expect(nav.locator(GROUP_TESTID)).toHaveCount(0);
      await expect(nav.locator('a[href="/docs"]')).toHaveAttribute("aria-current", "page");
      await expect(nav.getByRole("searchbox").or(nav.locator("input")).first()).toBeVisible();

      await page.goto("/docs/getting-started", { waitUntil: "networkidle" });
      await expect(page.getByTestId("docs-nav").locator(GROUP_TESTID)).toHaveCount(GROUPS.length);
    });

    test("a card link is body ink at rest, with an aria-hidden chevron, and takes the link colour on hover and on focus", async ({
      page,
    }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      // The ink the page's text is drawn in, read on <main>. In light it is document.body's own
      // colour (asserted below); in dark the theme sets the ink on the shell, and body itself
      // computes to the UA's white, which no text on the page is drawn in.
      const body = await page.locator("main").evaluate((el) => getComputedStyle(el).color);
      if (scheme === "light")
        expect(body).toBe(await page.evaluate(() => getComputedStyle(document.body).color));
      const link = page.getByTestId("docs-index").locator("a[href^='/docs/']").first();
      const colour = () => link.evaluate((el) => getComputedStyle(el).color);

      await page.mouse.move(0, 0);
      await expect.poll(colour, { message: "at rest" }).toBe(body);
      await expect(link.locator("svg[aria-hidden='true']")).toHaveCount(1);

      // The kit's links transition their colour, so wait for it to settle off the body ink.
      await link.hover();
      await expect.poll(colour, { message: "on hover" }).not.toBe(body);
      await page.waitForTimeout(400);
      const hovered = await colour();

      await page.mouse.move(0, 0);
      await expect.poll(colour, { message: "after the pointer leaves" }).toBe(body);
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(link).toBeFocused();
      await expect.poll(colour, { message: "on keyboard focus" }).toBe(hovered);
    });
  });
}
