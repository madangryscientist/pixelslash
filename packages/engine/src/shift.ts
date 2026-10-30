import type { Region } from "./regions.ts";

/**
 * Shift-aware regions (ob 1487).
 *
 * A browser that renders a page a fraction of a pixel off (a `translate(.5px)`, a fractional
 * layout offset, a different sub-pixel phase) repaints every glyph and edge in the region a
 * little differently. The pixels differ, but nothing was edited. A real 1px spacing change
 * differs in the same pixels yet is a different thing: one element moved against another.
 *
 * The rule. A `change` region is a `shift` only when ALL of these hold; otherwise it stays a
 * `change`:
 *
 *  1. Fractional. Fitting `Branch - Main ~ -s . grad((Main + Branch) / 2)` over the region's own
 *     box (first order, least squares, both axes, RGB) gives a shift `s` between MIN_SHIFT and
 *     `maxShift` pixels on its larger axis. A fit of a whole pixel or more is a real move. (A
 *     bilinear resample of Main does not reproduce Branch: Chromium rasterises glyphs afresh at
 *     the new phase, so the first-order fit is what explains the residue.)
 *  2. Explained. The fit accounts for at least MIN_EXPLAINED of the region's colour difference.
 *     Edits that are not a movement (a new word, a colour) are not explained by any `s`.
 *  3. Uniform, and edges against neighbours unchanged. The same fit is made per TILE over the
 *     region grown by NEIGHBOURHOOD pixels (24, about a line of text), and the tiles with edges
 *     in them must, by gradient energy, agree with the region's fit for at least MIN_AGREEMENT of
 *     that energy. A tile agrees when its fit is within half the region's shift (at most
 *     TILE_TOLERANCE, at least MIN_TILE_TOLERANCE) on both axes, so `s = 0` can never pass for a
 *     tile when the region moved. Content that moved alike agrees,
 *     wherever it sits. A moved element against a still one does not: the still neighbour's
 *     edges have energy, fit `s = 0`, and outvote the moved edge. The halo is what lets the
 *     neighbours vote; a halo with no edges in it (blank space) neither blocks nor proves a
 *     shift, so a page whose only content moved is still called a shift.
 *  4. Not an exact integer move. If Main shifted by exactly one pixel in x or y leaves at most
 *     INTEGER_RESIDUE of the differing pixels still differing, the content moved a whole pixel: a
 *     `change`, whatever the fit says.
 *
 * A fitting but non-integer move of one part of the page with no neighbour within the halo is
 * indistinguishable from a rendering shift and is called one. That is the rule's known edge.
 *
 * `maxShift` is the off switch: 0 labels nothing a `shift`.
 */

export const DEFAULT_MAX_SHIFT = 0.9;

/** A fit below this many pixels is too small to tell from nothing: stays a `change`. */
const MIN_SHIFT = 0.2;
/** The share of the colour difference the fit must explain. */
const MIN_EXPLAINED = 0.25;
/** Pixels around a region that are fitted too, so the neighbours' edges count. */
const NEIGHBOURHOOD = 24;
const TILE = 12;
/** A tile with less gradient energy than this (summed over its pixels and channels) has no edge to vote with. */
const MIN_TILE_ENERGY = 2000;
const MIN_TILES = 4;
const TILE_TOLERANCE = 0.35;
/** The smallest per-tile tolerance, so a still tile can never agree with a real shift. */
const MIN_TILE_TOLERANCE = 0.1;
const MIN_AGREEMENT = 0.5;
/** Of the differing pixels, the share a one-pixel shift of Main may leave and still be an exact move. */
const INTEGER_RESIDUE = 0.1;

export type ShiftOptions = {
  /** The largest fitted shift, in pixels, still called a `shift`. 0 turns the call off. */
  maxShift?: number;
};

/** The two shots, same size, RGBA. `delta` is the engine's pixel distance between Main at `ia` and Branch at `ib`. */
export type ShiftInput = {
  main: Uint8Array;
  branch: Uint8Array;
  width: number;
  height: number;
  /** Squared distance above which two pixels differ. */
  maxDelta: number;
  delta: (ia: number, ib: number) => number;
};

type Box = { x0: number; y0: number; x1: number; y1: number };

type Fit = { sx: number; sy: number; energy: number; explained: number };

/** Gradient moments of the pair over `box`, then the least-squares shift and what it explains. */
function fit(input: ShiftInput, box: Box): Fit {
  const { main, branch, width, height } = input;
  const at = (x: number, y: number, c: number) =>
    ((Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)) << 2) + c;
  const px = (data: Uint8Array, x: number, y: number, c: number) => data[at(x, y, c)] ?? 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxd = 0;
  let syd = 0;
  let dd = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      for (let c = 0; c < 3; c++) {
        const gx =
          (px(main, x + 1, y, c) +
            px(branch, x + 1, y, c) -
            px(main, x - 1, y, c) -
            px(branch, x - 1, y, c)) /
          4;
        const gy =
          (px(main, x, y + 1, c) +
            px(branch, x, y + 1, c) -
            px(main, x, y - 1, c) -
            px(branch, x, y - 1, c)) /
          4;
        const d = px(branch, x, y, c) - px(main, x, y, c);
        sxx += gx * gx;
        sxy += gx * gy;
        syy += gy * gy;
        sxd += gx * d;
        syd += gy * d;
        dd += d * d;
      }
    }
  }
  const det = sxx * syy - sxy * sxy;
  const energy = sxx + syy;
  if (det < 1e-6 || dd === 0) return { sx: 0, sy: 0, energy, explained: 0 };
  const sx = -(syy * sxd - sxy * syd) / det;
  const sy = -(sxx * syd - sxy * sxd) / det;
  // The model is m = -s . grad, so sum(m.d) = -(sx.sxd + sy.syd) and sum(m.m) = s' G s.
  const cross = -(sx * sxd + sy * syd);
  const model = sx * sx * sxx + 2 * sx * sy * sxy + sy * sy * syy;
  return { sx, sy, energy, explained: 1 - (dd - 2 * cross + model) / dd };
}

/** Half the region's shift, so `s = 0` (a still neighbour) can never count as agreeing with it. */
function tileTolerance(reach: number): number {
  return Math.min(TILE_TOLERANCE, Math.max(MIN_TILE_TOLERANCE, reach / 2));
}

function fitsAlike(a: Fit, b: Fit, tolerance: number): boolean {
  return Math.abs(a.sx - b.sx) < tolerance && Math.abs(a.sy - b.sy) < tolerance;
}

/** The share of the box's edge energy, by tile, that fits the same shift as the region does. */
function agreement(input: ShiftInput, box: Box, own: Fit): number | null {
  const tolerance = tileTolerance(Math.max(Math.abs(own.sx), Math.abs(own.sy)));
  let tiles = 0;
  let total = 0;
  let agreeing = 0;
  for (let ty = box.y0; ty < box.y1; ty += TILE) {
    for (let tx = box.x0; tx < box.x1; tx += TILE) {
      const t = fit(input, {
        x0: tx,
        y0: ty,
        x1: Math.min(tx + TILE, box.x1),
        y1: Math.min(ty + TILE, box.y1),
      });
      if (t.energy < MIN_TILE_ENERGY) continue;
      tiles++;
      total += t.energy;
      if (fitsAlike(t, own, tolerance)) agreeing += t.energy;
    }
  }
  return tiles < MIN_TILES ? null : agreeing / total;
}

/** Pixels of the box that differ between Main read at (x + dx, y + dy) and Branch at (x, y). */
function differing(input: ShiftInput, box: Box, dx: number, dy: number): number {
  const { width, height, maxDelta, delta } = input;
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const mx = x + dx;
      const my = y + dy;
      if (mx < 0 || my < 0 || mx >= width || my >= height) continue;
      if (Math.abs(delta((my * width + mx) << 2, (y * width + x) << 2)) > maxDelta) n++;
    }
  }
  return n;
}

/** Whether a whole-pixel shift of Main in x or y makes the box (all but INTEGER_RESIDUE of it) match. */
function isIntegerMove(input: ShiftInput, box: Box): boolean {
  const unshifted = differing(input, box, 0, 0);
  if (unshifted === 0) return false;
  const moves: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  return moves.some(([dx, dy]) => differing(input, box, dx, dy) <= unshifted * INTEGER_RESIDUE);
}

function isShift(input: ShiftInput, r: Region, maxShift: number): string | null {
  const grown: Box = {
    x0: Math.max(0, r.x - NEIGHBOURHOOD),
    y0: Math.max(0, r.y - NEIGHBOURHOOD),
    x1: Math.min(input.width, r.x + r.w + NEIGHBOURHOOD),
    y1: Math.min(input.height, r.y + r.h + NEIGHBOURHOOD),
  };
  const own = fit(input, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  const reach = Math.max(Math.abs(own.sx), Math.abs(own.sy));
  if (reach < MIN_SHIFT || reach > maxShift || own.explained < MIN_EXPLAINED) return null;
  const agrees = agreement(input, grown, own);
  if (agrees === null || agrees < MIN_AGREEMENT) return null;
  if (isIntegerMove(input, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })) return null;
  return `moved ${own.sx.toFixed(2)},${own.sy.toFixed(2)}px, all alike`;
}

/**
 * `change` regions whose content moved a fraction of a pixel, all alike, relabelled `shift`.
 * `noise` regions and the order are kept. Needs equal-size shots; the caller skips it otherwise.
 */
export function labelShifts(
  regions: Region[],
  input: ShiftInput,
  options: ShiftOptions = {},
): Region[] {
  const maxShift = options.maxShift ?? DEFAULT_MAX_SHIFT;
  if (maxShift <= 0) return regions;
  return regions.map((r) => {
    if (r.kind !== "change") return r;
    const why = isShift(input, r, maxShift);
    return why ? { ...r, kind: "shift", why } : r;
  });
}
