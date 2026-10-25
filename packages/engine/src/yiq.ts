/** The perceptual colour maths of the pixel diff (moved out of `diff.ts` unchanged, PS-204). */
import type { Raster } from "./diff-probe.ts";

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

/** Brightness difference of a neighbour against the centre pixel of the same shot. */
function brightnessDelta(d: Uint8Array, centre: number, neighbour: number): number {
  return lumaIq(d, centre)[0] - lumaIq(d, neighbour)[0];
}

function sameRgba(d: Uint8Array, a: number, b: number): boolean {
  return d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
}

/** In-bounds 8-neighbourhood of (x, y), as [x, y] pairs. */
function neighbours(img: Raster, x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, img.height - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, img.width - 1); nx++) {
      if (nx !== x || ny !== y) out.push([nx, ny]);
    }
  }
  return out;
}

/** More than two of the 8 neighbours share the pixel's exact colour: it sits in a flat area. */
function hasManySiblings(img: Raster, x: number, y: number): boolean {
  const at = (y * img.width + x) << 2;
  const same = neighbours(img, x, y).filter(([nx, ny]) =>
    sameRgba(img.data, at, (ny * img.width + nx) << 2),
  );
  return same.length > 2;
}

type Extreme = { delta: number; x: number; y: number };

/**
 * Whether (x, y) is an anti-aliased edge pixel of `img` (Vysniauskas, "On the detection of
 * anti-aliased pixels", 2009): its neighbours run both darker and lighter, few match it, and the
 * extreme neighbour sits in a flat area in both shots, i.e. the edge is a real, hard one.
 */
export function isAntialiased(img: Raster, x: number, y: number, other: Raster): boolean {
  const centre = (y * img.width + x) << 2;
  let equal = 0;
  const min: Extreme = { delta: 0, x: 0, y: 0 };
  const max: Extreme = { delta: 0, x: 0, y: 0 };
  for (const [nx, ny] of neighbours(img, x, y)) {
    const delta = brightnessDelta(img.data, centre, (ny * img.width + nx) << 2);
    if (delta === 0) equal++;
    else if (delta < min.delta) Object.assign(min, { delta, x: nx, y: ny });
    else if (delta > max.delta) Object.assign(max, { delta, x: nx, y: ny });
  }
  if (equal > 2 || min.delta === 0 || max.delta === 0) return false;
  const flatBoth = (e: Extreme) =>
    hasManySiblings(img, e.x, e.y) && hasManySiblings(other, e.x, e.y);
  return flatBoth(min) || flatBoth(max);
}
