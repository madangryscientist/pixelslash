import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { diffPngs } from "@pixelslash/engine";
import { caseKey, type CorpusCase } from "./corpus.ts";
import { extractRegions, maskFromRgba } from "./regions.ts";
import type { ToolResult } from "./types.ts";

/** PixelSlash's diff at its defaults: perceptual threshold, anti-aliased edges set aside, a size mismatch is a change (packages/engine/src/diff.ts). */
export function pixelslashDiff(base: Buffer, head: Buffer): ToolResult {
  const started = performance.now();
  const diff = diffPngs(base, head);
  const ms = performance.now() - started;
  const overlay = PNG.sync.read(diff.overlay);
  const regions = extractRegions(maskFromRgba(overlay.width, overlay.height, overlay.data));
  return {
    changed: diff.changed,
    regions,
    ms,
    note: `${diff.changedPixels} px${diff.antialiased > 0 ? `, ${diff.antialiased} anti-aliased` : ""}`,
    diffPng: diff.changed ? diff.overlay : null,
    sizeMismatch: diff.mainWidth !== diff.branchWidth || diff.mainHeight !== diff.branchHeight,
  };
}

/** Cases are keyed by `caseKey`; `base.png` is Main and `head.png` is Branch. */
export function runPixelslash(cases: CorpusCase[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const c of cases) {
    const base = readFileSync(join(c.dir, "base.png"));
    const head = readFileSync(join(c.dir, "head.png"));
    results.set(caseKey(c), pixelslashDiff(base, head));
  }
  return results;
}
