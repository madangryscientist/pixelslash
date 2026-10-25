import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type DiffIgnore, diffPngs } from "@pixelslash/engine/diff";
import { describe, expect, test } from "vitest";
import { png } from "../../e2e/png";
import { RED, shot } from "./test-shots";

/**
 * The Worker's diff is `diff.wasm` (PS-210): a `workerd` build of the engine's diff takes the
 * module as an import (`diff-module.workerd.ts`) and carries no pngjs, and on what the server diff
 * is given in the e2e runs and the server-diff tests it gives what pngjs gave before PS-210: the
 * whole result hashed, the overlay as its sha256. The engine's own test holds the bench corpus.
 */

const engine = join(import.meta.dirname, "../../../../packages/engine");

describe("the Worker diffs through diff.wasm (PS-210)", () => {
  test("a workerd build of the diff imports the module and no pngjs", async () => {
    const build = await Bun.build({
      entrypoints: [join(engine, "src/diff.ts")],
      conditions: ["workerd"],
      target: "node",
      external: ["node:*"],
      metafile: true,
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {});
    expect(inputs.some((path) => path.endsWith("src/diff-module.workerd.ts"))).toBe(true);
    expect(inputs.some((path) => path.endsWith("src/diff-module.bun.ts"))).toBe(false);
    expect(inputs.some((path) => path.endsWith("wasm/diff.wasm"))).toBe(true);
    expect(inputs.filter((path) => /pngjs|napi-rs/.test(path))).toEqual([]);
    expect(build.outputs.filter((output) => output.path.endsWith(".wasm"))).toHaveLength(1);
  });
});

type Case = {
  name: string;
  main: Buffer;
  branch: Buffer;
  ignore?: DiffIgnore;
  /** pngjs's whole result before PS-210, hashed as `hashOf` does. */
  want: string;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hashOf = (value: unknown) => sha256(Buffer.from(JSON.stringify(value))).slice(0, 16);

const changed = [{ x: 10, y: 10, w: 10, h: 10, rgb: RED }];
const burst = (n: number) => [{ x: 40 + n * 90, y: 300, w: 60, h: 400, rgb: RED }];
const blocks = [{ x: 5, y: 5, w: 20, h: 8, rgb: RED }];
const cases: Case[] = [
  {
    name: "a changed block",
    main: png(40, 40),
    branch: png(40, 40, changed),
    want: "3d9ba9825e9156ff",
  },
  {
    name: "a busy long page",
    main: png(1280, 2000, burst(0), 0),
    branch: png(1280, 2000, burst(1), 1),
    want: "08fb6e9f8d212d81",
  },
  {
    name: "a noise patch",
    main: Buffer.from(shot({ base: [128, 128, 128] })),
    branch: Buffer.from(
      shot({ base: [128, 128, 128], noise: { x: 10, y: 10, w: 40, h: 30, rgb: [0, 0, 0] } }),
    ),
    want: "3c488a67086467ce",
  },
  {
    name: "shot blocks",
    main: Buffer.from(shot()),
    branch: Buffer.from(shot({ blocks })),
    want: "3b9312aa1bf22415",
  },
  {
    name: "sizes differ",
    main: Buffer.from(shot()),
    branch: Buffer.from(shot({ width: 70, height: 40, blocks })),
    want: "8a46bc0963951c87",
  },
  {
    name: "ignore areas",
    main: png(40, 40),
    branch: png(40, 40, changed),
    ignore: {
      main: [{ x: 8, y: 8, width: 6, height: 6 }],
      branch: [{ x: 30, y: 30, width: 20, height: 20 }],
    },
    want: "2f31cc22f117b8e4",
  },
];

describe("the server diff gives pngjs's result byte for byte (PS-204, PS-210)", () => {
  test.each(cases)(
    "$name",
    ({ main, branch, ignore = {}, want }) => {
      const got = diffPngs(main, branch, {}, ignore);
      expect(hashOf({ ...got, overlay: got.overlay && sha256(got.overlay) })).toBe(want);
    },
    60_000,
  );
});
