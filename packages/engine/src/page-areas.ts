import type { Locator, Page } from "playwright";
import type { MaskRect } from "./config.ts";
import type { IgnoreRect } from "./diff.ts";

/** Masked regions are painted this colour, by Playwright for selectors and by us for rectangles. */
export const MASK_COLOR = "#FF00FF";

/**
 * Areas of a live page, measured at screenshot time: what the diff ignores and what is masked.
 * `capture` and `@hackcove/pixelslash-playwright` both measure through here, so the two read a page alike.
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

/** A `<video>` or `<audio>` on the page and its box, in whole CSS px from the top of the document. */
export type MediaBox = {
  tag: "video" | "audio";
  x: number;
  y: number;
  width: number;
  height: number;
};

type MeasuredMedia = Measured & { tagName: string };

/** Each media element's box in CSS px from the top of the document, unrounded. Runs in the page. */
function mediaOf(elements: MeasuredMedia[]): (Omit<MediaBox, "tag"> & { tag: string })[] {
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  });
}

/** One key per medium: the same box of the same kind is the same medium. */
export const mediaKey = (m: MediaBox): string => `${m.tag}\0${m.x},${m.y},${m.width},${m.height}`;

/** Whether `inner` lies wholly inside `outer` (the same unit for both). */
export function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Every `<video>` and `<audio>` on the live page that takes up room, boxes unrounded. Nothing is
 * touched: media renders unreliably (a spinner arc, a poster that arrives late), and the answer is to
 * exclude it, not to pause it.
 */
export async function measureMedia(page: Page): Promise<(Box & { tag: MediaBox["tag"] })[]> {
  const found = await page.locator("video, audio").evaluateAll(mediaOf);
  return found.flatMap((m) =>
    m.width > 0 && m.height > 0 ? [{ ...m, tag: m.tag === "audio" ? "audio" : "video" }] : [],
  );
}

/**
 * The media that is not already excluded: those no single ignore rect (image px) covers, as
 * whole-CSS-px boxes grown outward, so one can be pasted into an `ignore` rectangle as it is. The
 * test is on the unrounded box, in image px, the way an ignore area is resolved: a video that is
 * itself the `data-pixelslash-ignore` element is covered at any `deviceScaleFactor`. One only partly
 * inside is kept, with its whole box. Media that falls outside the image is dropped as well.
 */
export function unexcluded(
  media: Awaited<ReturnType<typeof measureMedia>>,
  ignore: IgnoreRect[],
  scale: number,
  image: { width: number; height: number },
): MediaBox[] {
  return media.flatMap((m) => {
    const [box] = toImageRects([m], scale, image);
    if (!box || ignore.some((r) => contains(r, box))) return [];
    const x = Math.floor(m.x);
    const y = Math.floor(m.y);
    return [
      {
        tag: m.tag,
        x,
        y,
        width: Math.ceil(m.x + m.width) - x,
        height: Math.ceil(m.y + m.height) - y,
      },
    ];
  });
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
