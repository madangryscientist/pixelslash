import { ENGINE_VERSION, diffPngs } from "./diff.ts";
import type { FlakyPolicy } from "./config.ts";
import type { Region } from "./regions.ts";
import type { Shoot, SnapshotEntry } from "./snapshot.ts";

/**
 * Flake detection (ob 1737). A shot that differs from its baseline is captured again; when a
 * capture disagrees with the first one, the page does not render the same twice, and the shot is
 * flaky. That says nothing about whether the change is wanted: it says the captures disagreed.
 * What a flaky shot does to a build (review it, or skip it) is the server's call, on the policy.
 */

/** One re-capture, numbered from 2: run 1 is the shot itself. */
export type FlakeRun = {
  run: number;
  png: Buffer;
  /** It differs from run 1 under the shot's own thresholds and ignore areas. */
  differed: boolean;
  /** The `change` regions between run 1 and this run; empty when it did not differ. */
  regions: Region[];
};

/** What a flaky shot uploads beside itself, as `meta.flake`. */
export type FlakeRecord = {
  /** Every capture, the first included. */
  runs: number;
  /** The runs that differed from run 1. */
  differed: number[];
  regions: { run: number; regions: Region[] }[];
  engineVersion: string;
  policy: FlakyPolicy;
};

export type FlakeCheck = { flaky: boolean; record: FlakeRecord; retries: FlakeRun[] };

/** Capture the shot `retries` more times and compare each capture with the first. */
export async function checkFlake(
  shot: Pick<SnapshotEntry, "diff" | "ignore" | "flaky">,
  first: Buffer,
  retries: number,
  again: () => Promise<Shoot>,
): Promise<FlakeCheck> {
  const runs: FlakeRun[] = [];
  for (let run = 2; run <= retries + 1; run++) {
    const { png, ignore } = await again();
    const diff = diffPngs(first, png, shot.diff, { main: shot.ignore, branch: ignore });
    const regions = diff.changed ? diff.regions.filter((r) => r.kind === "change") : [];
    runs.push({ run, png, differed: diff.changed, regions });
  }
  const differed = runs.filter((r) => r.differed);
  return {
    flaky: differed.length > 0,
    retries: runs,
    record: {
      runs: retries + 1,
      differed: differed.map((r) => r.run),
      regions: differed.map(({ run, regions }) => ({ run, regions })),
      engineVersion: ENGINE_VERSION,
      policy: shot.flaky,
    },
  };
}
