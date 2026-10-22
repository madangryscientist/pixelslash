import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { shotsOf } from "./check-rows.ts";
import { compareSnapshots } from "./compare-snapshots.ts";
import { pngSize } from "./dev-refs.ts";
import {
  type DevAgainst,
  type DevIteration,
  type DevShot,
  type DevStore,
  comparisonPoint,
  iterationDir,
  newIteration,
  pruneIterations,
  saveIteration,
} from "./dev-store.ts";
import { type CaptureSession, type SnapshotEntry, captureInto } from "./snapshot.ts";

/**
 * One `pixelslash dev` iteration (ob 1740): capture the target through the open session, compare it
 * with its comparison point (a pin, the previous iteration, or main's baselines), and save the
 * result. The page's own load and settle is timed apart from ours.
 */

/** Fetch main's baselines for `entries` into `dirs.main`; throws when the server cannot. */
export type FetchMain = (
  dirs: { branch: string; main: string },
  entries: SnapshotEntry[],
) => Promise<void>;

export type DevRunOptions = {
  store: DevStore;
  /** Already narrowed to the target. */
  session: CaptureSession;
  target: string;
  /** Set when the run is to be compared with main; unset is the previous iteration (or a pin). */
  main?: FetchMain | undefined;
  /** Why `--against main` was asked for and is not on (no credentials). */
  note?: string | undefined;
  maxBytes: number;
};

/** The session's `shoot`, adding up how long the page took to settle. */
function timedSession(session: CaptureSession): { session: CaptureSession; settled: () => number } {
  let settleMs = 0;
  const shoot: CaptureSession["shoot"] = async (route, variant) => {
    const got = await session.shoot(route, variant);
    settleMs += got.settleMs ?? 0;
    return got;
  };
  return { session: { ...session, shoot }, settled: () => settleMs };
}

/** An empty snapshot dir: the first run is compared with nothing, so every shot is new. */
async function emptySide(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "manifest.json"), `${JSON.stringify({ version: 1, snapshots: [] })}\n`);
  return dir;
}

type Side = { dir: string; against: DevAgainst; note: string | null };

/** The pin or previous iteration of the target, its shots dir; an empty side on the first run. */
async function localSide(opts: DevRunOptions, dir: string, note: string | null): Promise<Side> {
  const against = await comparisonPoint(opts.store, opts.target);
  if (against.iteration === null) return { dir: await emptySide(join(dir, "main")), against, note };
  return { dir: join(iterationDir(opts.store, against.iteration), "shots"), against, note };
}

/** Main's baselines; when the server cannot give them, the local side and a note saying why. */
async function sideOf(opts: DevRunOptions, dir: string, entries: SnapshotEntry[]): Promise<Side> {
  if (!opts.main) return localSide(opts, dir, opts.note ?? null);
  const mainDir = join(dir, "main");
  try {
    await opts.main({ branch: join(dir, "shots"), main: mainDir }, entries);
    return { dir: mainDir, against: { kind: "main", iteration: null }, note: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return localSide(opts, dir, `main's baselines unavailable (${why}); compared locally`);
  }
}

/** Run one iteration and save it; older iterations past the size cap are pruned (never a pin). */
export async function runIteration(opts: DevRunOptions): Promise<DevIteration> {
  const started = performance.now();
  const { id, dir } = await newIteration(opts.store);
  const timed = timedSession(opts.session);
  const shots = join(dir, "shots");
  const { manifest } = await captureInto(timed.session, shots);
  const side = await sideOf(opts, dir, manifest.snapshots);
  const report = join(dir, "report");
  const result = await compareSnapshots({ mainDir: side.dir, branchDir: shots, out: report });
  const rows = shotsOf(result, manifest.snapshots, { branch: shots, main: side.dir, report });
  const variantOf = new Map(manifest.snapshots.map((e) => [join(shots, e.file), e.variant.name]));
  const devShots: DevShot[] = [];
  for (const { files, ...row } of rows)
    devShots.push({
      name: row.name,
      shot: row.shot,
      status: row.status,
      changedPixels: row.changedPixels,
      regions: row.regions,
      variant: files.branch ? variantOf.get(files.branch) : undefined,
      size: files.branch ? ((await pngSize(files.branch)) ?? undefined) : undefined,
      files: { shot: files.branch, against: files.main, diff: files.diff, report: files.report },
    });
  const totalMs = performance.now() - started;
  const settleMs = timed.settled();
  const it: DevIteration = {
    id,
    target: opts.target,
    at: new Date().toISOString(),
    against: side.against,
    note: side.note,
    counts: {
      changed: result.changed.length,
      unchanged: result.unchanged.length,
      new: result.added.length,
      removed: result.removed.length,
    },
    regions: devShots.reduce((n, s) => n + s.regions.length, 0),
    changedPixels: devShots.reduce((n, s) => n + s.changedPixels, 0),
    timings: { oursMs: Math.max(0, totalMs - settleMs), settleMs, totalMs },
    dir,
    report: result.indexPath,
    shots: devShots,
    judge: null,
  };
  await saveIteration(it);
  await pruneIterations(opts.store, opts.maxBytes);
  return it;
}
