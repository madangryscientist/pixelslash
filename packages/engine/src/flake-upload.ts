import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UsageError } from "./errors.ts";
import { type FlakeCheck, type FlakeRecord, checkFlake } from "./flake.ts";
import { renderFlakeReport } from "./flake-report.ts";
import { identity } from "./manifest.ts";
import type { Shoot, SnapshotEntry } from "./snapshot.ts";

/**
 * Where a flaky shot's later runs are saved in the snapshot dir. `@` is outside the route and
 * story name alphabet, so no shot's own dir can be called this.
 */
export const FLAKE_DIR = "@flake";

/** A shot whose captures disagreed: the record sent with it, and its runs saved beside the dir. */
export type FlakyShot = { entry: SnapshotEntry; record: FlakeRecord; files: string[] };

/** A shot that differed from its baseline but could not be captured again, and why. */
export type SkippedShot = { entry: SnapshotEntry; why: string };

export type FlakeOutcome = {
  /** Shots that differed from their baseline, were captured again, and disagreed with themselves. */
  flaky: FlakyShot[];
  /** Shots that differed from their baseline, were captured again, and every capture agreed. */
  changed: SnapshotEntry[];
  /** Shots that differed from their baseline and were uploaded without being captured again. */
  skipped: SkippedShot[];
  /** `dir/report.html`, written whenever a changed shot could be captured again. */
  report: string | undefined;
};

type Rechecked = { e: SnapshotEntry; flake: FlakeCheck };

/** Remove what an earlier upload wrote into the dir, so a report never outlives its run. */
export async function clearFlakeOutput(dir: string): Promise<void> {
  await rm(join(dir, FLAKE_DIR), { recursive: true, force: true });
  await rm(join(dir, "report.html"), { force: true });
}

/** A flaky shot's re-captures as `@flake/<file>.run<N>.png` in the dir, for the local report. */
async function saveRuns(dir: string, rechecked: Rechecked[]): Promise<FlakyShot[]> {
  const flaky: FlakyShot[] = [];
  for (const { e, flake } of rechecked) {
    if (!flake.flaky) continue;
    const files: string[] = [];
    for (const r of flake.retries) {
      const file = `${FLAKE_DIR}/${e.file.replace(/\.png$/i, "")}.run${r.run}.png`;
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await Bun.write(join(dir, file), r.png);
      files.push(file);
    }
    flaky.push({ entry: e, record: flake.record, files });
  }
  return flaky;
}

type Recapture = (e: SnapshotEntry) => Promise<Shoot | undefined>;

/**
 * One upload's flake pass (ob 1737): a changed shot is captured `retries` more times as it goes
 * up, and at the end the flaky ones' runs and `report.html` are written into the dir. Without
 * `recapture`, or with 0 retries, nothing is captured again and no report is written.
 */
export function flakePass(opts: {
  dir: string;
  retries: number;
  recapture: Recapture | undefined;
  warn: (m: string) => void;
}) {
  const { dir, recapture, warn } = opts;
  const retries = recapture ? opts.retries : 0;
  const rechecked: Rechecked[] = [];
  const skipped: SkippedShot[] = [];
  let measured = 0;
  // One browser shoots one shot at a time: the upload's workers queue their re-captures here.
  let queue: Promise<unknown> = Promise.resolve();
  const again = (e: SnapshotEntry, png: Buffer) => {
    const run = queue.then(() =>
      checkFlake(e, png, retries, async () => {
        const shot = await recapture?.(e);
        if (!shot) throw new UsageError("the config has no such route or variant");
        return shot;
      }),
    );
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    retries,
    /** A shot was measured against its baseline, changed or not. */
    measured: () => {
      measured++;
    },
    /**
     * Capture a changed shot again. A shot the config no longer names, or a capture that fails,
     * is said and uploaded as it was: it is not called flaky on a run that did not happen.
     */
    async check(e: SnapshotEntry, png: Buffer): Promise<FlakeCheck | undefined> {
      if (retries === 0) return undefined;
      try {
        const flake = await again(e, png);
        rechecked.push({ e, flake });
        return flake;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        warn(`warning: ${identity(e)}: not captured again (${why}); uploading it as captured`);
        skipped.push({ entry: e, why });
        return undefined;
      }
    },
    /** Save the runs and write the report, in manifest order. A report that fails is said. */
    async finish(manifest: SnapshotEntry[]): Promise<FlakeOutcome> {
      if (retries === 0) return { flaky: [], changed: [], skipped, report: undefined };
      const order = new Map(manifest.map((e, i) => [e, i]));
      const byOrder = (a: SnapshotEntry, b: SnapshotEntry) =>
        (order.get(a) ?? 0) - (order.get(b) ?? 0);
      rechecked.sort((a, b) => byOrder(a.e, b.e));
      skipped.sort((a, b) => byOrder(a.entry, b.entry));
      const changed = rechecked.filter((r) => !r.flake.flaky).map((r) => r.e);
      try {
        const flaky = await saveRuns(dir, rechecked);
        const report = join(dir, "report.html");
        const shots = manifest.length;
        await Bun.write(
          report,
          renderFlakeReport({ flaky, changed, skipped, retries, measured, shots }),
        );
        return { flaky, changed, skipped, report };
      } catch (err) {
        warn(
          `warning: the flake report was not written: ${err instanceof Error ? err.message : String(err)}`,
        );
        const flaky = rechecked
          .filter((r) => r.flake.flaky)
          .map((r) => ({ entry: r.e, record: r.flake.record, files: [] }));
        return { flaky, changed, skipped, report: undefined };
      }
    },
  };
}
