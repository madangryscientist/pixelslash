import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DiffIgnore, type DiffOptions, diffPngs } from "@pixelslash/engine/diff";
import { wasmDiffer } from "@pixelslash/engine/diff-wasm";
import { describe, expect, test } from "vitest";
import { png } from "../../e2e/png";
import { RED, shot } from "./test-shots";

/**
 * The flag's WebAssembly diff (PS-204) against pngjs on what the server diff is given in the e2e
 * runs and the server-diff tests: every field equal and the overlay the same bytes. The engine's
 * own test holds the bench corpus; this holds the app's fixtures.
 */

const wasmPath = join(import.meta.dirname, "../../../../packages/engine/wasm/diff.wasm");
const fellBack: unknown[] = [];
const diff = wasmDiffer(new WebAssembly.Module(readFileSync(wasmPath)), {
  fellBack: (reason) => fellBack.push(reason),
});

type Case = {
  name: string;
  main: Buffer;
  branch: Buffer;
  options?: DiffOptions;
  ignore?: DiffIgnore;
};

const changed = [{ x: 10, y: 10, w: 10, h: 10, rgb: RED }];
const burst = (n: number) => [{ x: 40 + n * 90, y: 300, w: 60, h: 400, rgb: RED }];
const cases: Case[] = [
  { name: "a changed block", main: png(40, 40), branch: png(40, 40, changed) },
  {
    name: "a busy long page",
    main: png(1280, 2000, burst(0), 0),
    branch: png(1280, 2000, burst(1), 1),
  },
  {
    name: "a noise patch",
    main: Buffer.from(shot({ base: [128, 128, 128] })),
    branch: Buffer.from(
      shot({ base: [128, 128, 128], noise: { x: 10, y: 10, w: 40, h: 30, rgb: [0, 0, 0] } }),
    ),
  },
];

describe("the WebAssembly diff gives pngjs's result byte for byte (PS-204)", () => {
  test.each(cases)(
    "$name",
    ({ main, branch, options = {}, ignore = {} }) => {
      const want = diffPngs(main, branch, options, ignore);
      const got = diff(main, branch, options, ignore);
      expect({ ...got, overlay: null }).toEqual({ ...want, overlay: null });
      expect(got.overlay?.equals(want.overlay ?? Buffer.alloc(0))).toBe(true);
      expect(fellBack).toEqual([]);
    },
    60_000,
  );
});
