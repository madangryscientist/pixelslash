import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffPngs } from "@pixelslash/engine";
import { branchFile, mainFile } from "./fixtures.ts";

const WARMUP = 2;
const ITERATIONS = 5;

/**
 * Test-only: `PIXELSLASH_PERF_SLOW_DIFF_MS` makes every timed diff spin that many ms longer. The
 * runner passes it to the head probes alone, so a check can be shown to fail on a slow head.
 */
function slowdownMs(): number {
  return Number(process.env["PIXELSLASH_PERF_SLOW_DIFF_MS"] ?? 0) || 0;
}

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

/** `diffPngs` (decode, pixel diff, region clustering, overlay encode) on one fixed pair. */
export function timeDiff(fixtures: string, name: string): number[] {
  const main = readFileSync(join(fixtures, mainFile(name)));
  const branch = readFileSync(join(fixtures, branchFile(name)));
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
    const started = performance.now();
    const diff = diffPngs(main, branch);
    spin(slowdownMs());
    const elapsed = performance.now() - started;
    if (!diff.changed) throw new Error(`${name}: the fixture pair did not differ`);
    if (i >= WARMUP) samples.push(elapsed);
  }
  return samples;
}
