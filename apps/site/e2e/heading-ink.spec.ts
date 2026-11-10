import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { contrastRatio } from "./support/contrast.ts";

/*
 * Light-theme headings have their own, darker ink (PS-364). Latte's theme file maps the kit's
 * text-slate-900 to body grey, so without styles.css every heading in light reads as the body. The
 * first h1 on each page is measured at the deepest element that holds its text: on /pricing that is
 * the Display span inside the h1. Gradient text (.home-gradient-text) is transparent by design and
 * is skipped. The dark values were measured on main before this change and are pinned as they were.
 */

const INK_RGB: [number, number, number] = [35, 38, 52]; // #232634, --ps-heading on .latte
const INK = `rgb(${INK_RGB.join(", ")})`;
const GROUND: [number, number, number] = [239, 241, 245]; // #eff1f5, the light page ground
const LIGHT_MUTED = "rgb(100, 103, 125)"; // latte text-slate-400, measured on main
const DARK_HEADING = "rgb(205, 214, 244)"; // mocha text, measured on main
const DARK_MUTED = "rgb(150, 156, 181)"; // mocha text-slate-400, measured on main

const PAGES = ["/", "/pricing", "/docs", "/docs/getting-started"] as const;
// A plain h2 takes the new ink: no slate class, or the kit's own default text-slate-900. Muted
// card headings (text-slate-400 and 500) keep their slate, as styles.css does.
const PLAIN_H2 = "h2:not([class*='text-slate-']), h2.text-slate-900";
const MUTED_CARD_H2 = "h2:is(.text-slate-400, .text-slate-500)";

type Ink = { text: string; color: string };

/** The deepest element that holds a heading's text, as the brief defines it. Null when there is none. */
function textInk(heading: Locator): Promise<Ink | null> {
  return heading.evaluate((h) => {
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest(".home-gradient-text")) continue;
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

  test("h1 on each page is the darker ink, clear of the body; the first plain h2 on / is too; 12:1 on the ground; the muted card keeps its slate", async ({
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

    await open(page, "/");
    const h2 = await firstInk(page, PLAIN_H2);
    expect(h2, "/: a plain h2 in main").not.toBeNull();
    expect(h2?.color, `/ first plain h2 "${h2?.text}"`).toBe(INK);

    await open(page, "/docs");
    const muted = await firstInk(page, MUTED_CARD_H2);
    expect(muted, "/docs: a muted h2 in main").not.toBeNull();
    expect(muted?.color, "/docs muted card heading").toBe(LIGHT_MUTED);
  });
});

test.describe("at 1440 in dark", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  test("dark headings and the muted card keep the values measured on main", async ({ page }) => {
    await open(page, "/");
    const h1 = await firstInk(page, "h1");
    expect(h1, "/: an h1 in main").not.toBeNull();
    expect(h1?.color, "/ h1").toBe(DARK_HEADING);
    const h2 = await firstInk(page, PLAIN_H2);
    expect(h2, "/: a plain h2 in main").not.toBeNull();
    expect(h2?.color, "/ first plain h2").toBe(DARK_HEADING);

    await open(page, "/docs");
    const muted = await firstInk(page, MUTED_CARD_H2);
    expect(muted, "/docs: a muted h2 in main").not.toBeNull();
    expect(muted?.color, "/docs muted card heading").toBe(DARK_MUTED);
  });
});
