import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeGapsReport } from "./composition-report.ts";
import { resolveDiff, resolveFlaky } from "./config.ts";
import { clearFlakeOutput } from "./flake-upload.ts";
import { identity } from "./manifest.ts";
import type {
  CaptureSession,
  SnapshotEntry,
  SnapshotManifest,
  SnapshotResult,
} from "./snapshot.ts";
import { elapsed, type ShotTiming } from "./timings.ts";

/**
 * How many shots `captureInto` takes at once (PS-195). Most of a shot is the settle's network-idle
 * window, which is the page waiting, not the machine working; four pages wait together. Each page
 * still waits for its own fonts, images, network idle and two frames, bounded by its own timeout.
 */
export const CAPTURE_CONCURRENCY = 4;

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
 * config's order. Up to `concurrency` shots run at once, so the run's summed `captureMs` can exceed
 * its wall clock.
 */
export async function captureInto(
  session: CaptureSession,
  out: string,
  concurrency = CAPTURE_CONCURRENCY,
): Promise<SnapshotResult> {
  const { config, routes, fingerprint } = session;
  await mkdir(out, { recursive: true });
  await clearFlakeOutput(out);
  const pairs = config.variants.flatMap((variant) => routes.map((route) => ({ route, variant })));
  const taken = await mapLimit(pairs, concurrency, async ({ route, variant }) => {
    const file = `${route.name}/${variant.name}.png`;
    const started = performance.now();
    const { png, ignore, media, composition, a11y, steps } = await session.shoot(route, variant, {
      a11y: true,
    });
    const captureMs = elapsed(started);
    await mkdir(join(out, route.name), { recursive: true });
    await Bun.write(join(out, file), png);
    const entry: SnapshotEntry = {
      name: route.name,
      path: route.path,
      variant,
      tags: route.tags,
      diff: resolveDiff(config, route, variant),
      ignore,
      flaky: resolveFlaky(config, route),
      file,
      fingerprint,
      ...(composition && { composition }),
      ...(a11y && { a11y }),
    };
    const shot: ShotTiming = { name: identity(entry), captureMs, ...steps };
    return { entry, shot, media };
  });
  const snapshots = taken.map((t) => t.entry);
  const shots = taken.map((t) => t.shot);
  const media = Object.fromEntries(
    taken.filter((t) => t.media.length > 0).map((t) => [t.shot.name, t.media]),
  );
  const manifest: SnapshotManifest = { version: 1, snapshots };
  const manifestPath = join(out, "manifest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!config.composition) return { manifest, manifestPath, shots, media };
  const gapsPath = await writeGapsReport(out, manifest, config.composition.name);
  return { manifest, manifestPath, shots, media, gapsPath };
}
