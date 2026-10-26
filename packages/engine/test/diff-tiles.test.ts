import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import type { DiffIgnore, DiffOptions } from "../src/diff.ts";
import { isDiffExports } from "../src/diff-exports.ts";
import { wasmDiff } from "../src/diff-wasm.ts";

// PS-191: the tile pass hashes 64 px tiles and runs the pixel loop and the region pass only where
// they differ. It must give the whole-overlap answer, overlay included, or it is not an option. On
// every pair of both bench corpora that is `diff-wasm.test.ts`'s golden test: the tile pass is on by
// default, and the golden file holds the whole-overlap answer.

/** The result with the overlay as its sha256, so a mismatch prints what moved and not the bytes. */
function diffed(
  pair: [Buffer, Buffer],
  tiles: boolean,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
) {
  const { overlay, ...rest } = wasmDiff(pair, { tiles, options, ignore });
  return { ...rest, overlay: createHash("sha256").update(overlay).digest("hex") };
}

/** A `width` x `height` grey PNG with the given pixels painted black. */
function png(width: number, height: number, black: [number, number][] = []): Buffer {
  const img = new PNG({ width, height });
  img.data.fill(200);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  for (const [x, y] of black) img.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return PNG.sync.write(img);
}

/** A filled square of pixels, `size` on a side, from (x, y). */
const square = (x: number, y: number, size: number): [number, number][] =>
  Array.from({ length: size * size }, (_, i) => [x + (i % size), y + Math.floor(i / size)]);

describe("the tile pass at its edges (PS-191)", () => {
  const base = png(300, 400);

  test.each([
    // One blob across a tile boundary: the two tile rows' bands join.
    ["a blob across two tile rows", [...square(10, 60, 3), ...square(10, 80, 3)], {}],
    // Changes four tile rows apart: two bands, two blobs, kept in order.
    ["two bands", [...square(200, 10, 4), ...square(20, 300, 4)], {}],
    // Tile rows 0 and 2 with a gap of 32: the bands end and start on the same row and join, and
    // the blobs stay apart.
    ["touching bands", [...square(5, 10, 2), ...square(5, 140, 2)], { mergeDistance: 32 }],
    ["a gap of 0", [...square(5, 5, 2), ...square(9, 5, 2)], { mergeDistance: 0 }],
    ["a fractional gap", [...square(5, 60, 2), ...square(5, 90, 2)], { mergeDistance: 28.5 }],
    ["an infinite gap", [...square(5, 5, 2), ...square(250, 390, 2)], { mergeDistance: Infinity }],
    ["a change in the last, clipped, tile", square(297, 397, 3), {}],
  ] as const)("%s", (_, black, options) => {
    const pair: [Buffer, Buffer] = [base, png(300, 400, [...black])];
    expect(diffed(pair, true, options)).toEqual(diffed(pair, false, options));
  });

  test("shots of different sizes: only the overlap is tiled", () => {
    const pair: [Buffer, Buffer] = [base, png(270, 430, square(260, 395, 4))];
    const on = diffed(pair, true);
    expect(on).toEqual(diffed(pair, false));
    expect(on.changedPixels).toBe(16);
  });

  test("an ignore area inside a differing tile", () => {
    const pair: [Buffer, Buffer] = [
      base,
      png(300, 400, [...square(10, 10, 4), ...square(40, 10, 4)]),
    ];
    const ignore = { branch: [{ x: 38, y: 8, width: 10, height: 10 }] };
    const on = diffed(pair, true, {}, ignore);
    expect(on).toEqual(diffed(pair, false, {}, ignore));
    expect(on.changedPixels).toBe(16);
  });

  test("identical pixels in different PNG bytes: no tile differs, nothing changed", () => {
    const img = PNG.sync.read(base);
    const recoded = PNG.sync.write(img, { filterType: 0 });
    expect(recoded.equals(base)).toBe(false);
    const on = diffed([base, recoded], true);
    expect(on).toEqual(diffed([base, recoded], false));
    expect(on.changed).toBe(false);
  });
});

type Size = readonly [number, number];

/** `edged`'s grey level at (x, y): black outside the overlap, grey on its edge, a pattern inside. */
function edgedValue(x: number, y: number, ow: number, oh: number): number {
  if (x >= ow || y >= oh) return 0;
  if (x === ow - 1 || y === oh - 1) return 128;
  return 150 + ((x * 7 + y * 13) % 97);
}

/** How many pixels of `overlay` outside the `ow` x `oh` overlap are painted (not transparent). */
function paintedOutside(overlay: PNG, ow: number, oh: number): number {
  let painted = 0;
  for (let y = 0; y < overlay.height; y++) {
    for (let x = 0; x < overlay.width; x++) {
      const outside = x >= ow || y >= oh;
      if (outside && overlay.data[(y * overlay.width + x) * 4 + 3] !== 0) painted++;
    }
  }
  return painted;
}

/**
 * A `width` x `height` shot laid out around an `ow` x `oh` overlap: flat black outside it, grey on
 * its last row and column, and inside them a pattern in which no pixel has an identical
 * neighbour, with the `white` pixels painted white. A changed pixel on the overlap's edge then
 * has its darkest neighbour in the flat black just past the edge, so the anti-alias test asks
 * whether that neighbour is flat in the other shot, where it may not exist.
 */
function edged(
  [width, height]: Size,
  [ow, oh]: [number, number],
  white: readonly (readonly [number, number])[] = [],
): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = edgedValue(x, y, ow, oh);
      img.data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  for (const [x, y] of white) img.data.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return PNG.sync.write(img);
}

describe("shots of different sizes: changes on the overlap's edge (PS-222)", () => {
  // The repro was 1280x12879 against 1280x13311: both diffs panicked in the anti-alias test,
  // which read a pixel one row past the shorter shot when the changed pixel's unchanged side was
  // the taller shot. Each case runs with the change on the smaller shot and on the larger, and
  // with that shot as Main and as Branch.
  test.each([
    [
      "heights differ, not multiples of 64 (the repro's shape, 432 rows apart)",
      [1280, 207],
      [1280, 639],
    ],
    ["widths differ, not multiples of 64", [130, 200], [170, 200]],
    ["both differ", [130, 150], [170, 190]],
    ["one wider, the other taller", [170, 150], [130, 190]],
    ["one shot smaller than one tile", [40, 30], [100, 90]],
  ] as const)("%s", (_, first, second) => {
    const overlap: [number, number] = [
      Math.min(first[0], second[0]),
      Math.min(first[1], second[1]),
    ];
    const [ow, oh] = overlap;
    // The overlap's bottom-right corner, the middle of its last row, the middle of its last column.
    const changes = [
      [ow - 1, oh - 1],
      [ow >> 1, oh - 1],
      [ow - 1, oh >> 1],
    ] as const;
    const larger = [Math.max(first[0], second[0]), Math.max(first[1], second[1])];
    const runs: { pair: [Buffer, Buffer]; sizes: number[] }[] = [];
    for (const [plain, changed] of [
      [first, second],
      [second, first],
    ] as [Size, Size][]) {
      const shot = edged(plain, overlap);
      const edited = edged(changed, overlap, changes);
      runs.push({ pair: [shot, edited], sizes: [...plain, ...changed] });
      runs.push({ pair: [edited, shot], sizes: [...changed, ...plain] });
    }
    for (const { pair, sizes } of runs) {
      const on = diffed(pair, true);
      expect(on).toEqual(diffed(pair, false));
      expect(on.changedPixels).toBe(changes.length);
      // Both sizes are stated.
      expect([on.mainWidth, on.mainHeight, on.branchWidth, on.branchHeight]).toEqual(sizes);
      // The overlay is the larger size, and nothing outside the overlap is painted.
      const overlay = PNG.sync.read(wasmDiff(pair).overlay);
      expect([overlay.width, overlay.height]).toEqual(larger);
      expect(paintedOutside(overlay, ow, oh)).toBe(0);
    }
  });
});

describe("the region pass's halo (PS-191)", () => {
  const { exports } = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(join(import.meta.dirname, "../wasm/diff.wasm"))),
  );
  if (!isDiffExports(exports)) throw new Error("diff.wasm does not export the diff");
  const wasm = exports;
  const [w, h] = [128, 256];

  /** The boxes of a field with `changed` marked, by the whole pass or the banded one. */
  function boxes(
    changed: readonly (readonly [number, number])[],
    gap: number,
    tiled: boolean,
  ): number[] {
    wasm.reset();
    const kind = wasm.alloc(w * h);
    const field = new Uint8Array(wasm.memory.buffer, kind, w * h);
    field.fill(0);
    const len = wasm.tile_map_len(w, h);
    const map = wasm.alloc(len);
    const tiles = new Uint8Array(wasm.memory.buffer, map, len);
    tiles.fill(0);
    for (const [x, y] of changed) {
      field[y * w + x] = 1;
      tiles[Math.floor(y / 64) * 2 + Math.floor(x / 64)] = 1;
    }
    const out = wasm.alloc(4);
    const count = tiled
      ? wasm.blob_boxes_tiled(kind, w, h, gap, map, out)
      : wasm.blob_boxes(kind, w, h, gap, out);
    const [at = 0] = new Uint32Array(wasm.memory.buffer, out, 1);
    return [...new Uint32Array(wasm.memory.buffer, at, count * 4)];
  }

  // A gap of 40 joins pixels 65 rows apart, across tile row 1, which has no change: the bands of
  // tile rows 0 and 2 must reach into it, or the one blob comes out as two.
  test.each([
    [
      "across a clean tile row",
      [
        [3, 63],
        [3, 128],
      ],
      40,
      4,
    ],
    [
      "not quite across it",
      [
        [3, 63],
        [3, 128],
      ],
      31,
      8,
    ],
    [
      "a gap reaching every row",
      [
        [3, 0],
        [100, 255],
      ],
      1000,
      4,
    ],
    [
      "an infinite gap",
      [
        [3, 0],
        [100, 255],
      ],
      Infinity,
      4,
    ],
    [
      "no gap",
      [
        [3, 0],
        [4, 1],
      ],
      -1,
      0,
    ],
  ] as const)("%s", (_, changed, gap, cells) => {
    const want = boxes(changed, gap, false);
    expect(want).toHaveLength(cells);
    expect(boxes(changed, gap, true)).toEqual(want);
  });
});
