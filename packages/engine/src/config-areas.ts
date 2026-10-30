import type { Fail } from "./diff-options.ts";

/** A rectangle in full-page CSS px; scaled by the device scale factor when painted. */
export type MaskRect = { x: number; y: number; width: number; height: number };
/** A redact mask: a CSS selector (every match is painted over before the PNG is written) or a fixed rectangle. */
export type Mask = string | MaskRect;
/**
 * An ignore area: a CSS selector (every match, plus any `[data-pixelslash-ignore]` element) or a
 * rectangle in full-page CSS px. The pixels stay in the PNG; the diff skips them.
 */
export type Ignore = string | MaskRect;

function int(v: unknown, where: string, min: number, fail: Fail): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min)
    fail(where, min === 0 ? "must be a non-negative integer" : "must be a positive integer");
  return v;
}

/** One mask or ignore area: a non-empty selector, or `{ x, y, width, height }` in CSS px. */
export function parseArea(v: unknown, where: string, fail: Fail): Mask {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "string") fail(where, "must be a non-empty string");
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(where, "must be a CSS selector or { x, y, width, height }");
  const r: Record<string, unknown> = { ...v };
  return {
    x: int(r.x, `${where}.x`, 0, fail),
    y: int(r.y, `${where}.y`, 0, fail),
    width: int(r.width, `${where}.width`, 1, fail),
    height: int(r.height, `${where}.height`, 1, fail),
  };
}
