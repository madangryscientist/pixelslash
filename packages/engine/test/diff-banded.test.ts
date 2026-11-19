import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { diffPngsBanded } from "../src/diff.ts";
import { wasmDiffBanded } from "../src/diff-wasm.ts";

// The corpus and its golden answers are `diff-wasm.test.ts`'s: the banded diff must give the same.
const corpusRoot = join(import.meta.dirname, "../../../bench");
const golden: Record<string, { diff: string; measure: string }> = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/pngjs-golden.json"), "utf8"),
);
const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const overlaySha = (overlay: Buffer | null) =>
  overlay && createHash("sha256").update(overlay).digest("hex");
const pairOf = (name: string): [Buffer, Buffer] => [
  readFileSync(join(corpusRoot, name, "base.png")),
  readFileSync(join(corpusRoot, name, "head.png")),
];
/** The corpus tests diff whole page pairs: headroom for a loaded machine. */
const CORPUS_TIMEOUT = 30_000;
/** A real timer between bands, as the server's, so two diffs interleave. */
const aTimer = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the banded diff gives the same answer, pausing between bands (PS-464)", () => {
  test.each(Object.keys(golden))(
    "%s",
    async (name) => {
      const want = golden[name];
      const [main, branch] = pairOf(name);
      let pauses = 0;
      const pause = async () => {
        pauses++;
      };
      const diffed = await diffPngsBanded(main, branch, { pause });
      expect(hashOf({ ...diffed, overlay: overlaySha(diffed.overlay) })).toBe(want?.diff);
      // One tile row a band: every boundary the pixel loop has.
      const measured = await wasmDiffBanded([main, branch], { pause, bandTileRows: 1 });
      expect(hashOf({ ...measured, overlay: overlaySha(measured.overlay) })).toBe(want?.measure);
      expect(pauses).toBeGreaterThan(0);
    },
    CORPUS_TIMEOUT,
  );

  test(
    "two banded diffs at once, interleaved band by band, each get their own answer",
    async () => {
      const [first = "", second = ""] = Object.keys(golden);
      const [a, b] = await Promise.all(
        [first, second].map((name) =>
          wasmDiffBanded(pairOf(name), { pause: aTimer, bandTileRows: 1 }).then((m) =>
            hashOf({ ...m, overlay: overlaySha(m.overlay) }),
          ),
        ),
      );
      expect([a, b]).toEqual([golden[first]?.measure, golden[second]?.measure]);
    },
    CORPUS_TIMEOUT,
  );
});
