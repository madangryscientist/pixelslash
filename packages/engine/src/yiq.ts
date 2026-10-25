/**
 * The perceptual colour maths the shift labels use (moved out of `diff.ts` unchanged, PS-204). The
 * pixel loop and its anti-alias test run in `diff.wasm` (PS-210).
 */

/** Largest YIQ delta (squared, weighted) between black and white. */
export const MAX_YIQ_DELTA = 35215;

function lumaIq(data: Uint8Array, i: number): [number, number, number] {
  let r = data[i] ?? 0;
  let g = data[i + 1] ?? 0;
  let b = data[i + 2] ?? 0;
  const a = (data[i + 3] ?? 0) / 255;
  if (a < 1) {
    r = 255 + (r - 255) * a;
    g = 255 + (g - 255) * a;
    b = 255 + (b - 255) * a;
  }
  return [
    r * 0.29889531 + g * 0.58662247 + b * 0.11448223,
    r * 0.59597799 - g * 0.2741761 - b * 0.32180189,
    r * 0.21147017 - g * 0.52261711 + b * 0.31114694,
  ];
}

/** Perceptual distance between two pixels, signed: negative when `b` is the lighter one. */
export function colourDelta(a: Uint8Array, ia: number, b: Uint8Array, ib: number): number {
  const same =
    a[ia] === b[ib] &&
    a[ia + 1] === b[ib + 1] &&
    a[ia + 2] === b[ib + 2] &&
    a[ia + 3] === b[ib + 3];
  if (same) return 0;
  const [ya, ia_, qa] = lumaIq(a, ia);
  const [yb, ib_, qb] = lumaIq(b, ib);
  const dy = ya - yb;
  const di = ia_ - ib_;
  const dq = qa - qb;
  const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  return dy > 0 ? -delta : delta;
}
