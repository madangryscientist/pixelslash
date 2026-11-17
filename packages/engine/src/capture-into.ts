import { availableParallelism, loadavg } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeGapsReport } from "./composition-report.ts";
import { resolveDiff, resolveFlaky } from "./config.ts";
import { CaptureError, CaptureTimeout } from "./errors.ts";
import { clearFlakeOutput } from "./flake-upload.ts";
import { identity } from "./manifest.ts";
import { METRICS_SUFFIX, metricsText } from "./metrics-entry.ts";
import type {
  CaptureSession,
  SnapshotEntry,
  SnapshotManifest,
  SnapshotResult,
} from "./snapshot.ts";
import { elapsed, type ShotTiming } from "./timings.ts";

/**
 * The most shots `captureInto` takes at once when the config does not say (PS-195, PS-436). Most of
 * a shot is the page waiting (the network, fonts, images), not the machine working, so several
 * pages wait together. Each page still waits for its own fonts, images, the network and two
 * frames, bounded by its own timeout. Ten is the smallest count within 5% of the fastest median
 * in the run logged in `bench/PERF.md` (2026-11-12, dedicated, five cores).
 */
export const DEFAULT_CONCURRENCY_CAP = 10;

/**
 * The default worker count: the cores not already busy (cores minus the 1-minute load average,
 * rounded down), at most the cap, at least 1. A box that other work already saturates gets one
 * renderer at a time instead of ten more on top of it. `cores` and `load` are injectable so a test
 * never depends on the machine it runs on.
 */
export function defaultConcurrency(
  cores = availableParallelism(),
  load = loadavg()[0] ?? 0,
): number {
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY_CAP, Math.floor(cores - load)));
}

/** What the default is read from: the CPUs available to the process and the 1-minute load average. */
export type Machine = { cores: number; load: number };

/**
 * `fn` over `items`, at most `limit` at a time; the results are in `items`' order. A failure that
 * `setAside` accepts (a timeout) does not stop the run: that item waits until the pool has drained
 * and then runs once more, alone, with nothing else shooting. Any other failure stops new items from
 * starting and is thrown once the ones already running have finished, so nothing is still shooting
 * when the caller closes the browser; the items set aside are then not retried. A set-aside item
 * that times out again fails the run with its message and `RETRIED_ALONE`.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  announce: (count: number) => void,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  const queue = items.map((item, i) => ({ item, i }));
  const aside: { item: T; i: number }[] = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        results[next.i] = await fn(next.item);
      } catch (e) {
        if (e instanceof CaptureTimeout) {
          aside.push(next);
          continue;
        }
        queue.length = 0;
        throw e;
      }
    }
  };
  const done = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  if (aside.length > 0) announce(aside.length);
  for (const { item, i } of aside.toSorted((a, b) => a.i - b.i)) {
    try {
      results[i] = await fn(item);
    } catch (e) {
      throw e instanceof CaptureTimeout ? new CaptureError(`${e.message}${RETRIED_ALONE}`) : e;
    }
  }
  return results;
}

/**
 * The worker count and, when the machine's load lowered it, the line that says why. A `concurrency`
 * that was given is returned as it is, silently.
 */
function workerCount(
  given: number | undefined,
  machine: Machine,
  warn: (message: string) => void,
): number {
  if (given !== undefined) return given;
  const picked = defaultConcurrency(machine.cores, machine.load);
  if (picked < Math.min(DEFAULT_CONCURRENCY_CAP, Math.max(1, machine.cores)))
    warn(
      `concurrency: ${picked} (${machine.cores} CPUs, load ${machine.load.toFixed(1)}); the machine is busy, so fewer shots at once`,
    );
  return picked;
}

/** The line for shots set aside after a timeout, printed before they are retried alone. */
function announceRetry(warn: (message: string) => void): (count: number) => void {
  return (count) =>
    warn(
      `retry: ${count} ${count === 1 ? "shot" : "shots"} timed out under load; retried alone after the run`,
    );
}

/** The note when a shot that timed out failed again on its own, at the end of the run. */
export const RETRIED_ALONE = "; retried alone after the run and timed out again";

/**
 * Every route × variant of the session's config into `out`, and `out/manifest.json`, in the
 * config's order. Up to `concurrency` shots run at once (the config's `concurrency`, else
 * `defaultConcurrency()`), so the run's summed `captureMs` can exceed
 * its wall clock; the result carries both, as `captureWallMs` and the workers that shared it.
 * With `reuse` (`capture --upload` only, PS-445) a story may be shot on a pooled preview page; the
 * result's `reused` names those shots, so the upload can shoot again on a fresh page any that differs.
 *
 * A machine that is busy slows a page down without breaking it. So a shot that times out (a
 * `CaptureTimeout`) does not stop the run: it is set aside and, once the rest has finished, shot
 * again one at a time with its full `timeoutMs`; only a timeout there fails the run. Any other
 * failure stops the run at once. The default worker count also gives way to the machine's load, and
 * both say so on `warn` (stderr by default). A given `concurrency` is obeyed and says nothing.
 */
export async function captureInto(
  session: CaptureSession,
  out: string,
  given: number | undefined = session.config.concurrency,
  {
    reuse = false,
    warn = (message) => void process.stderr.write(`${message}\n`),
    machine = { cores: availableParallelism(), load: loadavg()[0] ?? 0 },
  }: { reuse?: boolean; warn?: (message: string) => void; machine?: Machine } = {},
): Promise<SnapshotResult> {
  const { config, routes } = session;
  const concurrency = workerCount(given, machine, warn);
  await mkdir(out, { recursive: true });
  await clearFlakeOutput(out);
  const pairs = config.variants.flatMap((variant) => routes.map((route) => ({ route, variant })));
  const workers = Math.max(1, Math.min(concurrency, pairs.length));
  const shooting = performance.now();
  const taken = await mapLimit(
    pairs,
    concurrency,
    async ({ route, variant }) => {
      const file = `${route.name}/${variant.name}.png`;
      const started = performance.now();
      const { png, ignore, media, composition, a11y, metrics, steps, reused } = await session.shoot(
        route,
        variant,
        { a11y: true, metrics: true, reuse },
      );
      const captureMs = elapsed(started);
      await mkdir(join(out, route.name), { recursive: true });
      await Bun.write(join(out, file), png);
      const metricsFile = metrics && file.replace(/\.png$/, METRICS_SUFFIX);
      if (metrics && metricsFile) await Bun.write(join(out, metricsFile), metricsText(metrics));
      const entry: SnapshotEntry = {
        name: route.name,
        path: route.path,
        variant,
        tags: route.tags,
        diff: resolveDiff(config, route, variant),
        ignore,
        flaky: resolveFlaky(config, route),
        file,
        fingerprint: session.fingerprintFor(variant.browser),
        ...(composition && { composition }),
        ...(a11y && { a11y }),
        ...(metricsFile && { metrics: metricsFile }),
      };
      const shot: ShotTiming = { name: identity(entry), captureMs, ...steps };
      return { entry, shot, media, reused: reused === true };
    },
    announceRetry(warn),
  );
  const captureWallMs = elapsed(shooting);
  const snapshots = taken.map((t) => t.entry);
  const shots = taken.map((t) => t.shot);
  const media = Object.fromEntries(
    taken.filter((t) => t.media.length > 0).map((t) => [t.shot.name, t.media]),
  );
  const manifest: SnapshotManifest = { version: 1, snapshots };
  const manifestPath = join(out, "manifest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const reused = new Set(taken.filter((t) => t.reused).map((t) => t.shot.name));
  const wall = { captureWallMs, captureWorkers: workers, ...(reuse && { reused }) };
  if (!config.composition) return { manifest, manifestPath, shots, media, ...wall };
  const gapsPath = await writeGapsReport(out, manifest, config.composition.name);
  return { manifest, manifestPath, shots, media, gapsPath, ...wall };
}
