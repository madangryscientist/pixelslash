import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { box, hydrated } from "./support/header.ts";

/*
 * A doc page gives its text the room (PS-401). The rail stays 224px, "On this page" is 12rem from xl
 * (1280) and the text takes the rest; below xl the contents list folds into the page. The columns
 * stay inside the header's column, as columns.spec.ts measures it: L is the brand link's left edge,
 * R the right edge of the last link or button that shows.
 */
const RAIL_GAP = 40; // the kit's SidebarLayout: `md:gap-10`
const TOLERANCE = 1;

async function open(page: Page): Promise<{ right: number }> {
  await page.goto("/docs/cli", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await hydrated(page);
  const header = page.locator("header").first();
  const last = await box(header.locator("a:visible, button:visible").last());
  return { right: last.x + last.w };
}

/** How many tables have a scroller (itself or an ancestor with overflow-x) that is wider than it shows. */
async function tablesThatScroll(page: Page): Promise<{ scrolling: number; total: number }> {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('[data-testid="docs-article"] table')];
    const scrolling = tables.filter((table) => {
      for (let node = table.parentElement; node; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowX)) {
          return node.scrollWidth > node.clientWidth + 1;
        }
      }
      return false;
    });
    return { scrolling: scrolling.length, total: tables.length };
  });
}

test.describe("doc page columns", () => {
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  test("at 1440 the text takes the room and the contents list is 12rem on the header's right edge", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { right } = await open(page);
    const rail = await box(page.locator('aside[aria-label="Docs"]'));
    const article = await box(page.getByTestId("docs-article"));
    const contents = await box(page.locator('aside:has([data-testid="docs-contents"])'));

    expect(contents.w, "contents column width").toBeLessThanOrEqual(200);
    expect(article.w, "content column width").toBeGreaterThanOrEqual(600);
    expect(Math.abs(article.x - (rail.x + rail.w + RAIL_GAP)), "content left").toBeLessThanOrEqual(
      TOLERANCE,
    );
    expect(
      Math.abs(contents.x + contents.w - right),
      "contents right is the header's right",
    ).toBeLessThanOrEqual(TOLERANCE);

    const { scrolling, total } = await tablesThatScroll(page);
    info.annotations.push({
      type: "tables that scroll sideways at 1440",
      description: `${scrolling} of ${total}`,
    });
    process.stdout.write(`/docs/cli at 1440: ${scrolling} of ${total} tables scroll sideways\n`);
  });

  test("at 1100 the contents list folds and the text takes everything right of the rail", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const { right } = await open(page);
    const rail = await box(page.locator('aside[aria-label="Docs"]'));
    const article = await box(page.getByTestId("docs-article"));

    await expect(page.locator('aside:has([data-testid="docs-contents"])')).toBeHidden();
    await expect(page.locator("details", { hasText: "On this page" })).toBeVisible();
    expect(article.w, "content column width").toBeGreaterThanOrEqual(760);
    expect(Math.abs(article.x - (rail.x + rail.w + RAIL_GAP)), "content left").toBeLessThanOrEqual(
      TOLERANCE,
    );
    expect(Math.abs(article.x + article.w - right), "content right").toBeLessThanOrEqual(TOLERANCE);
  });
});
