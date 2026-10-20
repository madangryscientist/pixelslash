/**
 * What a case is, and the helpers the case lists are written with (ob 1477, ob 1488). Each case
 * renders one fixture page twice, `base` and `head`, and is labelled by what a reviewer should
 * conclude: `identical`, `noise` (a change nobody would want flagged) or `real` (a change somebody
 * should see, with the elements it touches in `box`).
 */
export type Dither = { seed: number; amp: number; density: number };

export type Variant = {
  /** Render this file (path from the repo root) instead of the case's fixture page. */
  source?: string;
  /** Extra CSS injected after load. */
  css?: string;
  /** A JS expression-statement run in the page after load, before the shot. */
  js?: string;
  /** Extra Chromium flags; a different flag set means a different browser launch. */
  args?: string[];
  /** A fontconfig file from fixtures/fontconfig/ (hinting and anti-aliasing), by name without `.conf`. */
  fontconfig?: string;
  /** Post-process the PNG: seeded +-amp noise on `density` of the pixels (GPU rasterisation drift). */
  dither?: Dither;
  /** Round-trip the shot through JPEG at this quality (lossy compression artefacts). */
  jpeg?: number;
  /** Round-trip the shot through WebP at this quality (lossy, through a canvas in Chromium). */
  webp?: number;
};

export type Label = "identical" | "noise" | "real";

export type CaseDef = {
  name: string;
  label: Label;
  /** Category inside the label, for the per-category table. */
  kind: string;
  /** A page of the case's corpus set: `<page>.html` in its fixtures directory. */
  page: string;
  fullPage?: boolean;
  base: Variant;
  head: Variant;
  /**
   * Real cases: selectors whose rects (in either render) make the ground-truth box. A `text:`
   * prefix takes the rect of the text itself, not of the (often full-width) element holding it.
   */
  box?: string[];
};

export const same = (name: string, page: string, extra: Partial<CaseDef> = {}): CaseDef => ({
  name,
  label: "identical",
  kind: "identical",
  page,
  base: {},
  head: {},
  ...extra,
});

export const noise = (
  kind: string,
  name: string,
  page: string,
  ...pair: [base: Variant, head: Variant]
): CaseDef => ({ name: `noise-${name}`, label: "noise", kind, page, base: pair[0], head: pair[1] });

export const real = (
  kind: string,
  name: string,
  page: string,
  ...spec: [head: Variant, box: string[], extra?: Partial<CaseDef>]
): CaseDef => ({
  name: `real-${name}`,
  label: "real",
  kind,
  page,
  base: {},
  head: spec[0],
  box: spec[1],
  ...spec[2],
});

export const HINT_NONE: Variant = { fontconfig: "hint-none" };
export const HINT_FULL: Variant = { fontconfig: "hint-full" };
export const HINT_LCD: Variant = { fontconfig: "hint-slight-lcd" };
export const NO_SUBPIXEL = ["--disable-font-subpixel-positioning"];

export const seek = (ms: number) =>
  `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${ms}; });`;
export const caretBar = (sel: string, x: number) =>
  `${sel}{background:linear-gradient(#18181b,#18181b) no-repeat ${x}px center / 1px 16px,#fff}`;
export const setText = (sel: string, text: string) =>
  `document.querySelector(${JSON.stringify(sel)}).textContent = ${JSON.stringify(text)};`;
export const setSvg = (sel: string, inner: string) =>
  `document.querySelector(${JSON.stringify(sel)}).innerHTML = ${JSON.stringify(inner)};`;
