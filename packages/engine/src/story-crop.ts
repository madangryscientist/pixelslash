import type { Page } from "playwright";
import { PNG } from "pngjs";
import { readPngSize } from "./identical.ts";

/**
 * Storybook shots are cropped to the story, not the viewport (PS-286). A story is shot full-page
 * like a route, but a button renders in a corner of a 1280x720 page; the crop keeps the content
 * box plus `STORY_PADDING` and drops the background around it. A route is never cropped.
 */

/** CSS px kept around the story's content box. */
const STORY_PADDING = 8;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Where the crop sits on the full-page shot: the origin in whole CSS px (so every box measured in
 * full-page CSS px shifts by it exactly, at any `deviceScaleFactor`) and the rectangle in image px.
 */
export type Crop = { origin: { x: number; y: number } } & Box;

/**
 * Browser globals the box measure touches (the tsconfig has no DOM lib). Type-only: `storyBox`
 * is serialized and runs in the page, where these are the real globals.
 */
type El = {
  tagName: string;
  id: string;
  className: unknown;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  querySelectorAll(selector: string): ArrayLike<El>;
};
type Animation = { effect: { getComputedTiming(): { endTime: number } } | null; finish(): void };
declare const document: {
  body: El & { classList: { contains(name: string): boolean }; children: ArrayLike<El> };
  documentElement: { scrollWidth: number; scrollHeight: number };
  getAnimations(): Animation[];
  getElementById(id: string): El | null;
};
declare const window: {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(el: El): { visibility: string; opacity: string };
};

/**
 * The story's content box in CSS px from the top of the document, or null to keep the full page: a
 * `fullscreen` story (Storybook marks `<body>` `sb-main-fullscreen`) and one that rendered nothing
 * a box can be taken of. The box is the union of every visible element under `#storybook-root` and
 * of every visible element portalled into `<body>` beside it (popovers, menus, dialogs, toasts),
 * each clipped to the document first so an element parked off-screen does not stretch it. Storybook's
 * own chrome (`.sb-*`, `#storybook-docs`) is not content. With `finish`, finite animations are run to
 * their end first, as the screenshot's `animations: "disabled"` does, so a popover that fades or
 * slides in is measured where the shot shows it. Runs in the page.
 */
function storyBox(finish: boolean): Box | null {
  if (document.body.classList.contains("sb-main-fullscreen")) return null;
  const root = document.getElementById("storybook-root");
  if (!root) return null;
  const settleAnimations = () => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
    }
  };
  if (finish) settleAnimations();
  const maxX = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const maxY = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const seen = (el: El): boolean => {
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.opacity !== "0";
  };
  const add = (el: El) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || !seen(el)) return;
    const x0 = Math.max(0, r.left + window.scrollX);
    const y0 = Math.max(0, r.top + window.scrollY);
    const x1 = Math.min(maxX, r.left + r.width + window.scrollX);
    const y1 = Math.min(maxY, r.top + r.height + window.scrollY);
    if (x1 <= x0 || y1 <= y0) return;
    left = Math.min(left, x0);
    top = Math.min(top, y0);
    right = Math.max(right, x1);
    bottom = Math.max(bottom, y1);
  };
  const within = (parent: El) => {
    for (const el of Array.from(parent.querySelectorAll("*"))) add(el);
  };
  within(root);
  const portalled = (el: El): boolean => {
    const skipped = ["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE"].includes(el.tagName);
    const chrome = el.id === "storybook-docs" || /(^|\s)sb-/.test(String(el.className));
    return el !== root && !skipped && !chrome && seen(el);
  };
  for (const el of Array.from(document.body.children)) {
    if (!portalled(el)) continue;
    add(el);
    within(el);
  }
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** The story's content box on the settled page; null keeps the full page (see `storyBox`). */
export function measureStoryBox(page: Page, finishAnimations: boolean): Promise<Box | null> {
  return page.evaluate(storyBox, finishAnimations);
}

/**
 * The crop for `box` (CSS px) on a full-page shot of `image` px: grown by `STORY_PADDING`, rounded
 * out to whole CSS px, clipped to the page. Null when it leaves the whole shot, or none of it.
 */
export function storyCrop(
  box: Box,
  scale: number,
  image: { width: number; height: number },
): Crop | null {
  const x = Math.max(0, Math.floor(box.x - STORY_PADDING));
  const y = Math.max(0, Math.floor(box.y - STORY_PADDING));
  const right = Math.min(image.width, Math.ceil(box.x + box.width + STORY_PADDING) * scale);
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height + STORY_PADDING) * scale);
  const width = right - x * scale;
  const height = bottom - y * scale;
  if (width <= 0 || height <= 0) return null;
  if (width === image.width && height === image.height) return null;
  return { origin: { x, y }, x: x * scale, y: y * scale, width, height };
}

/** `crop` cut out of `png`. */
function cropPng(png: Buffer, crop: Crop): Buffer {
  const img = PNG.sync.read(png);
  const out = new PNG({ width: crop.width, height: crop.height });
  PNG.bitblt(img, out, crop.x, crop.y, crop.width, crop.height, 0, 0);
  return PNG.sync.write(out);
}

/** The full-page shot cut to `story`'s crop, with the crop origin; the shot itself, no origin, when it is not cropped. */
export function storyShot(
  full: Buffer,
  story: Box | null,
  scale: number,
): { png: Buffer; origin?: Crop["origin"] } {
  const size = story && readPngSize(full);
  const crop = story && size && storyCrop(story, scale, size);
  return crop ? { png: cropPng(full, crop), origin: crop.origin } : { png: full };
}

/**
 * Boxes in full-page CSS px, moved into the cropped shot: shifted by the crop origin and cut at its
 * top and left edge. Right and bottom are left to whoever scales them to image px, which clips to
 * the image. A box wholly above or left of the crop is dropped.
 */
export function shiftBoxes<T extends Box>(boxes: T[], origin: Crop["origin"] | undefined): T[] {
  if (!origin) return boxes;
  return boxes.flatMap((b) => {
    const x = b.x - origin.x;
    const y = b.y - origin.y;
    const width = b.width + Math.min(0, x);
    const height = b.height + Math.min(0, y);
    return width > 0 && height > 0
      ? [{ ...b, x: Math.max(0, x), y: Math.max(0, y), width, height }]
      : [];
  });
}
