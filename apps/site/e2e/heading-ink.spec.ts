import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { contrastRatio } from "./support/contrast.ts";

/*
 * Light-theme headings have their own, darker ink (PS-364). Latte's theme file maps the kit's
 * text-slate-900 to body grey, so without styles.css every heading in light reads as the body. The
 * first h1 on each page is measured at the deepest element that holds its text: a Display span
 * inside the h1, where there is one. The dark values were measured on main before this change and
 * are pinned as they were. No page here has a muted card heading any more (the pricing page that
 * had one moved to slashslash.build), so the muted slate is not measured.
 */

const INK_RGB: [number, number, number] = [35, 38, 52]; // #232634, --ps-heading on .latte
const INK = `rgb(${INK_RGB.join(", ")})`;
const GROUND: [number, number, number] = [239, 241, 245]; // #eff1f5, the light page ground
const DARK_HEADING = "rgb(205, 214, 244)"; // mocha text, measured on main

const PAGES = ["/security", "/docs", "/docs/getting-started"] as const;
// A plain h2 takes the new ink: no slate class, or the kit's own default text-slate-900.
const PLAIN_H2 = "h2:not([class*='text-slate-']), h2.text-slate-900";

type Ink = { text: string; color: string };

/** The deepest element that holds a heading's text, as the brief defines it. Null when there is none. */
function textInk(heading: Locator): Promise<Ink | null> {
  return heading.evaluate((h) => {
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      return {
        text: (el.textContent ?? "").trim().slice(0, 60),
        color: getComputedStyle(el).color,
      };
    }
    return null;
  });
}

/** The first heading in main that matches the selector, read at its text, or null. */
async function firstInk(page: Page, selector: string): Promise<Ink | null> {
  const found = page.locator(`main :is(${selector})`);
  if ((await found.count()) === 0) return null;
  return textInk(found.first());
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("at 1440 in light", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  test("h1 on each page is the darker ink, clear of the body; the first plain h2 on /security is too; 12:1 on the ground", async ({
    page,
  }) => {
    // The brief's bar, checked once on the pair it names.
    expect(contrastRatio(INK_RGB, GROUND)).toBeGreaterThanOrEqual(12);

    for (const path of PAGES) {
      await open(page, path);
      const body = await page.evaluate(() => getComputedStyle(document.body).color);
      const h1 = await firstInk(page, "h1");
      expect(h1, `${path}: an h1 with text in main`).not.toBeNull();
      expect(h1?.color, `${path} h1 "${h1?.text}"`).toBe(INK);
      expect(h1?.color, `${path} h1 against the body`).not.toBe(body);
    }

    await open(page, "/security");
    const h2 = await firstInk(page, PLAIN_H2);
    expect(h2, "/security: a plain h2 in main").not.toBeNull();
    expect(h2?.color, `/security first plain h2 "${h2?.text}"`).toBe(INK);

    await open(page, "/docs");
    const card = await firstInk(page, PLAIN_H2);
    expect(card, "/docs: a group card h2 in main").not.toBeNull();
    expect(card?.color, "/docs group card heading").toBe(INK);
  });
});

test.describe("at 1440 in dark", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  test("dark headings keep the values measured on main", async ({ page }) => {
    await open(page, "/security");
    const h1 = await firstInk(page, "h1");
    expect(h1, "/security: an h1 in main").not.toBeNull();
    expect(h1?.color, "/security h1").toBe(DARK_HEADING);
    const h2 = await firstInk(page, PLAIN_H2);
    expect(h2, "/security: a plain h2 in main").not.toBeNull();
    expect(h2?.color, "/security first plain h2").toBe(DARK_HEADING);

    await open(page, "/docs");
    const card = await firstInk(page, PLAIN_H2);
    expect(card, "/docs: a group card h2 in main").not.toBeNull();
    expect(card?.color, "/docs group card heading").toBe(DARK_HEADING);
  });
});
