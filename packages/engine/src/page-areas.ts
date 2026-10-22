import type { Locator, Page } from "playwright";
import type { MaskRect } from "./config.ts";
import type { IgnoreRect } from "./diff.ts";

/**
 * Areas of a live page, measured at screenshot time: what the diff ignores and what is masked.
 * `capture` and `@pixelslash/playwright` both measure through here, so the two read a page alike.
 */

/** The attribute that marks an element as an ignore area without a config entry. */
const IGNORE_ATTRIBUTE = "data-pixelslash-ignore";

/**
 * Browser globals the box measure touches (the tsconfig has no DOM lib). Type-only: the callback in
 * `boxesOf` is serialized and runs in the page, where these are the real globals.
 */
declare const window: { scrollX: number; scrollY: number };
type Measured = {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};

/**
 * Each element's box in CSS px: from the viewport, or with `fullPage` from the top of the document
 * (viewport box plus the scroll offset). Runs in the page.
 */
function boxesOf(elements: Measured[], fullPage: boolean): MaskRect[] {
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + (fullPage ? window.scrollX : 0),
      y: r.top + (fullPage ? window.scrollY : 0),
      width: r.width,
      height: r.height,
    };
  });
}

/**
 * Every match of every selector and every `[data-pixelslash-ignore]` element on the live page, as
 * CSS-px boxes (see `boxesOf`). A selector that matches nothing is passed to `unmatched`.
 */
export async function measureIgnore(
  page: Page,
  selectors: string[],
  fullPage: boolean,
  unmatched: (selector: string) => void,
): Promise<MaskRect[]> {
  const boxes: MaskRect[] = [];
  for (const selector of [...selectors, `[${IGNORE_ATTRIBUTE}]`]) {
    const loc = page.locator(selector);
    if ((await loc.count()) === 0) {
      if (!selector.startsWith(`[${IGNORE_ATTRIBUTE}`)) unmatched(selector);
      continue;
    }
    boxes.push(...(await loc.evaluateAll(boxesOf, fullPage)));
  }
  return boxes;
}

/** A locator per mask selector, for `page.screenshot`; a selector that matches nothing is passed to `unmatched`. */
export async function maskLocators(
  page: Page,
  selectors: string[],
  unmatched: (selector: string) => void,
): Promise<Locator[]> {
  const locators = selectors.map((s) => page.locator(s));
  for (const [i, loc] of locators.entries()) {
    if ((await loc.count()) === 0) unmatched(selectors[i] ?? "");
  }
  return locators;
}

/**
 * CSS-px boxes to image px: scaled by `scale`, grown outward to whole pixels, clipped to the image.
 * Boxes that end up empty (zero-size elements, boxes wholly off the image) are dropped.
 */
export function toImageRects(
  boxes: { x: number; y: number; width: number; height: number }[],
  scale: number,
  image: { width: number; height: number },
): IgnoreRect[] {
  const out: IgnoreRect[] = [];
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * scale));
    const y0 = Math.max(0, Math.floor(b.y * scale));
    const x1 = Math.min(image.width, Math.ceil((b.x + b.width) * scale));
    const y1 = Math.min(image.height, Math.ceil((b.y + b.height) * scale));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}
