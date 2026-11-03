import type { MetricsPart } from "./metrics-entry.ts";
import {
  EXACT_FIELDS,
  LENGTH_FIELDS,
  isColorField,
  type ParityField,
  type ParityManifest,
  type ParityPlatform,
  type ParityValue,
} from "./parity-manifest.ts";
import type { MismatchKind } from "./parity-types.ts";

/** How each compared field is read, worded and judged equal (PS-296). Pure. */

const EPSILON = 1e-9;

export const LABELS: Record<ParityField, string> = {
  "box.x": "x",
  "box.y": "y",
  "box.w": "width",
  "box.h": "height",
  "padding.top": "top padding",
  "padding.right": "right padding",
  "padding.bottom": "bottom padding",
  "padding.left": "left padding",
  gap: "gap",
  "font.size": "font size",
  "font.weight": "font weight",
  "font.lineHeight": "line height",
  "color.fg": "text colour",
  "color.bg": "background colour",
  "color.border": "border colour",
};

const READERS: Record<ParityField, (p: MetricsPart) => ParityValue | undefined> = {
  "box.x": (p) => p.box.x,
  "box.y": (p) => p.box.y,
  "box.w": (p) => p.box.w,
  "box.h": (p) => p.box.h,
  "padding.top": (p) => p.padding?.top,
  "padding.right": (p) => p.padding?.right,
  "padding.bottom": (p) => p.padding?.bottom,
  "padding.left": (p) => p.padding?.left,
  gap: (p) => p.gap,
  "font.size": (p) => p.font?.size,
  "font.weight": (p) => p.font?.weight,
  "font.lineHeight": (p) => p.font?.lineHeight,
  "color.fg": (p) => p.color?.fg,
  "color.bg": (p) => p.color?.bg,
  "color.border": (p) => p.color?.border,
};

/** A part's value for a field, `undefined` when that platform did not measure it. */
export const read = (p: MetricsPart, f: ParityField): ParityValue | undefined => READERS[f](p);

export const scaleOf = (s: number | null): number =>
  s !== null && Number.isFinite(s) && s > 0 ? s : 1;

const isLength = (f: ParityField): boolean => LENGTH_FIELDS.some((x) => x === f);

/** Two values of one field are the same: within `tol` for a length, equal for the rest. */
export function same(f: ParityField, a: ParityValue, b: ParityValue, tol: number): boolean {
  if (isLength(f) && typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= tol + EPSILON;
  return a === b;
}

export function kindOf(f: ParityField): MismatchKind {
  if (isColorField(f)) return "color";
  return EXACT_FIELDS.some((x) => x === f) ? "exact" : "length";
}

/** Whether the manifest's colour allowlist lists exactly this web value against this native one. */
export function allowedColor(
  manifest: ParityManifest,
  web: ParityValue,
  native: ParityValue,
  nativePlatform: ParityPlatform,
): boolean {
  return manifest.colors.some(
    (c) =>
      c.web === web &&
      c.native === native &&
      (c.platform === undefined || c.platform === nativePlatform),
  );
}
