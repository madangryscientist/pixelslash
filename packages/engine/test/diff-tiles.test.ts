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
