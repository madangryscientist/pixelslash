import { availableParallelism } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeGapsReport } from "./composition-report.ts";
import { resolveDiff, resolveFlaky } from "./config.ts";
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

/** The default worker count: the cap, or fewer when the machine has fewer cores; at least 1. */
export function defaultConcurrency(cores = availableParallelism()): number {
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY_CAP, cores));
}

/**
 * `fn` over `items`, at most `limit` at a time; the results are in `items`' order. The first failure
 * stops new items from starting and is thrown once the ones already running have finished, so
 * nothing is still shooting when the caller closes the browser.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  const queue = items.map((item, i) => ({ item, i }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        results[next.i] = await fn(next.item);
      } catch (e) {
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
  return results;
}

/**
 * Every route × variant of the session's config into `out`, and `out/manifest.json`, in the
 * config's order. Up to `concurrency` shots run at once (the config's `concurrency`, else
 * `defaultConcurrency()`), so the run's summed `captureMs` can exceed
 * its wall clock; the result carries both, as `captureWallMs` and the workers that shared it.
 */
export async function captureInto(
  session: CaptureSession,
  out: string,
  concurrency: number = session.config.concurrency ?? defaultConcurrency(),
): Promise<SnapshotResult> {
  const { config, routes } = session;
  await mkdir(out, { recursive: true });
  await clearFlakeOutput(out);
  const pairs = config.variants.flatMap((variant) => routes.map((route) => ({ route, variant })));
  const workers = Math.max(1, Math.min(concurrency, pairs.length));
  const shooting = performance.now();
  const taken = await mapLimit(pairs, concurrency, async ({ route, variant }) => {
    const file = `${route.name}/${variant.name}.png`;
    const started = performance.now();
    const { png, ignore, media, composition, a11y, metrics, steps } = await session.shoot(
      route,
      variant,
      { a11y: true, metrics: true },
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
    return { entry, shot, media };
  });
  const captureWallMs = elapsed(shooting);
  const snapshots = taken.map((t) => t.entry);
  const shots = taken.map((t) => t.shot);
  const media = Object.fromEntries(
    taken.filter((t) => t.media.length > 0).map((t) => [t.shot.name, t.media]),
  );
  const manifest: SnapshotManifest = { version: 1, snapshots };
  const manifestPath = join(out, "manifest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const wall = { captureWallMs, captureWorkers: workers };
  if (!config.composition) return { manifest, manifestPath, shots, media, ...wall };
  const gapsPath = await writeGapsReport(out, manifest, config.composition.name);
  return { manifest, manifestPath, shots, media, gapsPath, ...wall };
}
