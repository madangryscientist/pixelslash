import { expect, test } from "@playwright/test";
import { GROUPS } from "../src/content/docs-map.ts";

/*
 * PS-365: the /docs landing has a hierarchy. Each group card's title is a real heading, apart in
 * colour from its summary; the links inside are body ink with a chevron at rest and the link
 * colour on hover and keyboard focus; and the landing has no rail at all (PS-370), its search box
 * and group cards run the full column. Run on the desktop project at 1440x900, in both themes.
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

    // Light only: the layout does not depend on the scheme, and the rail check runs once.
    if (scheme === "light")
      test("/docs has no rail, and its search box sits above the first card; /getting-started keeps all twelve groups", async ({
        page,
      }) => {
        await page.goto("/docs", { waitUntil: "networkidle" });
        // The rail is SidebarLayout's aside, labelled "Docs"; the landing renders none.
        await expect(page.getByRole("complementary", { name: "Docs" })).toHaveCount(0);

        const search = page.getByRole("searchbox", { name: "Search the docs" });
        await expect(search).toBeVisible();
        // Reached by the keyboard alone: Tab from the top of the page until the search box has focus.
        await page.evaluate(() => {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement) focused.blur();
        });
        await expect(async () => {
          await page.keyboard.press("Tab");
          await expect(search).toBeFocused({ timeout: 100 });
        }).toPass({ timeout: 15_000 });
        const firstCard = await page
          .getByTestId("docs-index")
          .locator(":scope > li")
          .first()
          .boundingBox();
        const box = await search.boundingBox();
        if (!firstCard || !box) throw new Error("the search box or the first card has no box");
        expect(box.y + box.height, "search ends above the first card").toBeLessThanOrEqual(
          firstCard.y,
        );

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

/*
 * PS-366: on a phone the "New here?" callout stacks. Its text takes the full width and sits above the
 * button, which is full width too, so the text is not squeezed into a narrow column beside it.
 */
test("at 390 the docs callout stacks: its text is wide and sits above the button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs", { waitUntil: "networkidle" });
  const text = page.locator('[data-testid="docs-start"] > div > div:first-child');
  const button = page.getByTestId("docs-first-step");
  const [t, b] = await Promise.all([text.boundingBox(), button.boundingBox()]);
  if (!t || !b) throw new Error("callout text or button has no box");
  expect(b.y).toBeGreaterThan(t.y + t.height);
  expect(t.width).toBeGreaterThanOrEqual(300);
});
