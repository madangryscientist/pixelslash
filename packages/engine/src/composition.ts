import type { Page } from "playwright";
import type { CompositionLibrary } from "./composition-library.ts";
import { type CssBox, type Walked, walkSource } from "./composition-walk.ts";
import {
  CUSTOM_ATTRIBUTE,
  MAX_FINDINGS,
  MAX_TEXT,
  type Composition,
  type Gap,
  type SpecialCase,
} from "./composition-entry.ts";
import { toImageRects } from "./page-areas.ts";
import { shiftBoxes, type Crop } from "./story-crop.ts";

/**
 * Composition-only capture (ob 1850): on a project built from one design-system library's
 * components, every element that carries its own styling outside them is a finding. No model is
 * asked; this is a measure of the live DOM against the library's own class strings (see
 * `composition-library.ts` for how a library element is told from the app's).
 */

export {
  CUSTOM_ATTRIBUTE,
  GAP_COLOUR,
  GAP_LABEL,
  MAX_FINDINGS,
  MAX_TEXT,
  SPECIAL_COLOUR,
  gapReason,
  gapWhat,
  parseCompositionEntry,
  type Composition,
  type Gap,
  type GapKind,
  type SpecialCase,
} from "./composition-entry.ts";
export { loadLibrary, type CompositionLibrary } from "./composition-library.ts";

/** One CSS-px box in image px, or null when it is wholly off the image. */
function imageBox(
  box: CssBox,
  scale: number,
  image: { width: number; height: number },
  origin: Crop["origin"] | undefined,
) {
  return toImageRects(shiftBoxes([box], origin), scale, image)[0] ?? null;
}

/** `s` cut to `MAX_TEXT`, so one `data:` URL style does not fill the row. */
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** At most `MAX_FINDINGS`, special cases first (they are few and declared); the rest are counted. */
function capped(library: string, gaps: Gap[], special: SpecialCase[]): Composition {
  const keptSpecial = special.slice(0, MAX_FINDINGS);
  const keptGaps = gaps.slice(0, MAX_FINDINGS - keptSpecial.length);
  const omitted = gaps.length + special.length - keptGaps.length - keptSpecial.length;
  const found = { library, gaps: keptGaps, special: keptSpecial };
  return omitted > 0 ? { ...found, omitted } : found;
}

/**
 * Walk the live page against the library: gaps and special cases, boxes in image px (scaled and
 * clipped like the ignore boxes), capped and cut to fit an upload. A declared selector the browser refuses is passed to `warn`.
 */
export async function measureComposition(
  page: Page,
  lib: CompositionLibrary,
  shot: {
    scale: number;
    image: { width: number; height: number };
    /** The crop origin when the shot is cropped (full-page CSS px): boxes are shifted onto the cropped image. */
    origin?: Crop["origin"] | undefined;
    warn: (m: string) => void;
  },
): Promise<Composition> {
  const walked = await page.evaluate<Walked>(
    walkSource({
      chunks: lib.chunks,
      styleProps: lib.styleProps,
      custom: lib.custom,
      attribute: CUSTOM_ATTRIBUTE,
    }),
  );
  for (const s of walked.invalid)
    shot.warn(`warning: composition.custom selector "${s}" is not a valid selector`);
  const gaps: Gap[] = [];
  for (const g of walked.gaps) {
    const box = imageBox(g.box, shot.scale, shot.image, shot.origin);
    if (box)
      gaps.push({
        ...g,
        selector: clip(g.selector),
        classes: g.classes.map(clip),
        style: g.style === null ? null : clip(g.style),
        box,
      });
  }
  const special: SpecialCase[] = [];
  for (const s of walked.special) {
    const box = imageBox(s.box, shot.scale, shot.image, shot.origin);
    if (box) special.push({ selector: clip(s.selector), reason: clip(s.reason), box });
  }
  return capped(lib.name, gaps, special);
}
