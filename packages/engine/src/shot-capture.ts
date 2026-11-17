import type { Page } from "playwright";
import { scanA11y } from "./a11y.ts";
import { measureMetrics } from "./metrics-walk.ts";
import { stepsOf, type Opened } from "./capture-open.ts";
import { measureComposition, type CompositionLibrary } from "./composition.ts";
import type { Ignore, Route, Stabilise, Variant } from "./config.ts";
import type { IgnoreRect } from "./diff.ts";
import {
  maskLocators,
  measureIgnore,
  measureMedia,
  MASK_COLOR,
  toImageRects,
  unexcluded,
} from "./page-areas.ts";
import { paintRects } from "./paint-rects.ts";
import type { Session } from "./setup.ts";
import type { Shoot } from "./snapshot.ts";
import { measureStoryBox, shiftBoxes, storyShot, type Crop } from "./story-crop.ts";
import { elapsed, timed } from "./timings.ts";
import type { UnmatchedTally } from "./unmatched.ts";

/**
 * One shot read off a settled page, fresh or pooled: the screenshot, its crop, its masks and what
 * is measured on the page after it.
 */

/** The shot as it is kept: its size in image px and, for a cropped story, the crop origin in full-page CSS px. */
type Frame = { image: { width: number; height: number }; origin?: Crop["origin"] | undefined };

/**
 * Resolve ignore areas on the live page to image-px boxes: every match of every selector, every
 * `[data-pixelslash-ignore]` element, and the fixed rectangles. Nothing is painted. A selector that
 * matches nothing is tallied for the run, like a mask's.
 */
async function resolveIgnoreBoxes(
  page: Page,
  areas: Ignore[],
  shot: Pick<Shot, "stabilise" | "unmatched">,
  frame: Frame,
): Promise<IgnoreRect[]> {
  const selectors = areas.filter((a) => typeof a === "string");
  const misses = shot.unmatched.checked("ignore", selectors);
  const boxes = await measureIgnore(page, selectors, true, misses);
  boxes.push(...areas.filter((a) => typeof a !== "string"));
  const scale = shot.stabilise.deviceScaleFactor;
  return toImageRects(shiftBoxes(boxes, frame.origin), scale, frame.image);
}

export type Shot = {
  url: string;
  route: Route;
  variant: Variant;
  stabilise: Stabilise;
  /** Ignore areas to resolve at screenshot time; the pixels are left as they are. */
  ignore: Ignore[];
  /** What the config's `setup` left signed in, if it has one. */
  session: Session | undefined;
  /** The library a composition-only project is measured against; undefined for any other project. */
  library: CompositionLibrary | undefined;
  /** Scan the settled page for accessibility violations (PS-238). */
  a11y: boolean;
  /** Read every `[data-part]` element's box and style into the layout metrics file (PS-294). */
  metrics: boolean;
  warn: (m: string) => void;
  unmatched: UnmatchedTally;
};

/**
 * What is read off the settled page once it is shot: the ignore boxes, media, composition and a11y
 * scan. `png` is the shot as it is kept; a story's crop moves its `origin` (full-page CSS px) to the
 * top left, so every box is shifted to sit on the same pixels.
 */
async function measure(page: Page, shot: Shot, png: Buffer, origin?: Crop["origin"]) {
  const { stabilise } = shot;
  // The PNG's size from its IHDR chunk, without decoding the image.
  const frame = {
    image: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
    origin,
  };
  const ignore = await resolveIgnoreBoxes(page, shot.ignore, shot, frame);
  const media = unexcluded(
    shiftBoxes(await measureMedia(page), origin),
    ignore,
    stabilise.deviceScaleFactor,
    frame.image,
  );
  const composition =
    shot.library &&
    (await measureComposition(page, shot.library, {
      scale: stabilise.deviceScaleFactor,
      image: frame.image,
      origin,
      warn: shot.warn,
    }));
  // Read like the boxes above: the settled page, after the shot, before anything is let run.
  const metrics = shot.metrics ? ((await measureMetrics(page)) ?? undefined) : undefined;
  // After the screenshot and the measurements, so nothing the scan lets run can reach the PNG.
  // axe waits on timers, which `timers` has paused for good: let the page clock run again first.
  if (shot.a11y && stabilise.timers) await page.clock.resume();
  const a11y = shot.a11y ? await scanA11y(page) : undefined;
  return { ignore, media, composition, a11y, metrics };
}

/** The settled page shot: cropped to its story when it is one, then measured in the frame it is kept in. */
export async function capture(
  page: Page,
  shot: Shot,
  opened: Opened,
  setupMs: number,
): Promise<Shoot> {
  const { stabilise, route } = shot;
  const selectors = route.masks.filter((m) => typeof m === "string");
  const locators = await maskLocators(page, selectors, shot.unmatched.checked("mask", selectors));
  // Measured before the shot, on the settled page, in the frame the shot is taken in.
  const story = route.storybook ? await measureStoryBox(page, stabilise.animations) : null;
  const shooting = performance.now();
  const full = await page.screenshot({
    fullPage: true,
    animations: stabilise.animations ? "disabled" : "allow",
    caret: stabilise.caret ? "hide" : "initial",
    mask: locators,
    maskColor: MASK_COLOR,
  });
  const screenshotMs = elapsed(shooting);
  const { png, origin } = storyShot(full, story, stabilise.deviceScaleFactor);
  const { value: measured, ms: measureMs } = await timed(() => measure(page, shot, png, origin));
  const { ignore, media, composition, a11y, metrics } = measured;
  const rects = route.masks.filter((m) => typeof m !== "string");
  return {
    png: paintRects(png, shiftBoxes(rects, origin), stabilise.deviceScaleFactor),
    ignore,
    media,
    loadMs: opened.navigateMs + opened.settleMs,
    steps: stepsOf(opened, { setupMs, screenshotMs, measureMs }),
    ...(composition && { composition }),
    ...(a11y && { a11y }),
    ...(metrics && { metrics }),
  };
}
