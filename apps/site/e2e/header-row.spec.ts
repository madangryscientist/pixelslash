import { expect, test } from "@playwright/test";
import { PAGES } from "../src/content/pages.ts";
import { box, hydrated, toggleOf } from "./support/header.ts";
import { menuButton } from "./support/site-nav.ts";

const LABELS = PAGES.map((one) => one.label);

/*
 * The desktop header is one row from md (PS-353): the brand, the nav, then the theme toggle and Get
 * started, at most 64px tall. Below lg Home leaves the nav (the wordmark links home), so the tabs fit
 * at 768; from lg every tab shows. Both themes are checked at 1280 and 1440, the widths the ticket names;
 * 768 and 1024 are checked in light, since the scheme does not change the layout. Desktop project only.
 */
const ROW_MAX = 64;
const WIDTHS = [768, 1024, 1280, 1440] as const;

for (const width of WIDTHS) {
  for (const scheme of ["light", "dark"] as const) {
    if (scheme === "dark" && width < 1280) continue;
    test.describe(`at ${width} in ${scheme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: scheme });
      test.skip(({ isMobile }) => isMobile, "the desktop project only");

      test("the header is one row, at most 64px, with the nav beside the brand", async ({
        page,
      }) => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await hydrated(page);
        await expect(menuButton(page)).toBeHidden();

        const header = await box(page.locator("header").first());
        expect(header.h).toBeLessThanOrEqual(ROW_MAX);
        const nav = page.getByTestId("site-nav").filter({ visible: true });
        const navBox = await box(nav);
        expect(navBox.y).toBeGreaterThanOrEqual(header.y);
        expect(navBox.y + navBox.h).toBeLessThanOrEqual(header.y + header.h);

        // Every link that shows sits on one line: the row did not wrap.
        const shown = width < 1024 ? LABELS.filter((label) => label !== "Home") : LABELS;
        const tops: number[] = [];
        for (const label of shown) {
          const link = nav.getByRole("link", { name: label, exact: true });
          await expect(link).toBeVisible();
          tops.push(Math.round((await box(link)).y));
        }
        expect(new Set(tops).size).toBe(1);
        const home = nav.getByRole("link", { name: "Home", exact: true });
        if (width < 1024) await expect(home).toHaveCount(0);
        else await expect(home).toBeVisible();

        // The toggle and Get started sit inside the header, after the nav.
        const toggle = await box(toggleOf(page));
        const getStarted = await box(
          page.locator("header").first().getByRole("link", { name: "Get started" }),
        );
        for (const item of [toggle, getStarted]) {
          expect(item.x + item.w).toBeLessThanOrEqual(header.x + header.w);
          expect(item.y).toBeGreaterThanOrEqual(header.y);
          expect(item.y + item.h).toBeLessThanOrEqual(header.y + header.h);
        }
        expect(navBox.x + navBox.w).toBeLessThanOrEqual(toggle.x);
      });

      if (width === 768 || width === 1024) {
        test("the row neither wraps nor scrolls sideways, and nothing in it is clipped", async ({
          page,
        }) => {
          await page.goto("/", { waitUntil: "networkidle" });
          await page.evaluate(() => document.fonts.ready);
          await hydrated(page);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          const clipped = await page
            .locator("header")
            .first()
            .evaluate((header) =>
              [header, ...header.querySelectorAll("*")]
                .filter((element) => !element.classList.contains("sr-only"))
                .filter((element) => {
                  const style = getComputedStyle(element);
                  return (
                    element.scrollWidth > element.clientWidth + 1 && style.overflowX !== "visible"
                  );
                })
                .map((element) => element.tagName),
            );
          expect(clipped).toEqual([]);
        });
      }
    });
  }
}

test.describe("at 768 in light, the page it is on", () => {
  test.use({ viewport: { width: 768, height: 900 }, colorScheme: "light" });
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  test("is marked in the row, though Home is not shown there", async ({ page }) => {
    await page.goto("/docs/", { waitUntil: "networkidle" });
    const nav = page.getByTestId("site-nav").filter({ visible: true });
    await expect(nav.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
