import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffPngs, type PixelDiff } from "@pixelslash/engine";
import { caseKey, type CorpusCase } from "./corpus.ts";
import type { Rect } from "./regions.ts";
import type { ToolResult } from "./types.ts";

/** The engine's own regions, not noise ones: those are kept in the result but are not "changed". */
export function changeRegions(diff: PixelDiff): Rect[] {
  return diff.regions.filter((r) => r.kind === "change").map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** PixelSlash's diff at its defaults: perceptual threshold, anti-aliased edges set aside, a size mismatch is a change (packages/engine/src/diff.ts). */
export function pixelslashDiff(base: Buffer, head: Buffer): ToolResult {
  const started = performance.now();
  const diff = diffPngs(base, head);
  const ms = performance.now() - started;
  const regions = changeRegions(diff);
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
