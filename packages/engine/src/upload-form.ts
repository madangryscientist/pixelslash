import { createHash } from "node:crypto";
import { type CiResult, ENGINE_VERSION } from "./ci-diff.ts";
import type { FlakeCheck } from "./flake.ts";
import { pngPath } from "./manifest.ts";
import { readMetricsFile } from "./metrics-file.ts";
import { serverBrowser, serverPlatform } from "./native.ts";
import type { SnapshotEntry } from "./snapshot.ts";

/** What a shot sends beside its meta and PNG. */
export type ShotExtras = {
  results: CiResult[];
  flake: FlakeCheck | undefined;
  note: string | null;
  /** The shot's layout metrics file, exactly as it is on disk (PS-294). */
  metrics: Uint8Array | undefined;
  /**
   * The PNG's sha256 when the server already holds that image (PS-424): the shot is registered by
   * hash and its `file` part is left out. Everything else is sent as for any shot.
   */
  byHash?: string | undefined;
};

/** The sha256 of a PNG's bytes, as the server computes it for a file it receives. */
export const sha256Of = (png: Uint8Array): string => createHash("sha256").update(png).digest("hex");

/** A shot's PNG path and bytes, and its metrics file's bytes when it has one (undefined for a shot without). */
export async function readShot(dir: string, e: SnapshotEntry) {
  const file = pngPath(dir, e);
  const png = Buffer.from(await Bun.file(file).arrayBuffer());
  const metrics = e.metrics ? (await readMetricsFile(dir, e.metrics)).bytes : undefined;
  return { file, png, metrics };
}

/**
 * One shot's upload: its meta and PNG; in a CI project, what it measured against each baseline;
 * for a flaky shot, the flake record and every re-capture as `flake:<run>` (ob 1737); and the
 * judge's sentence, when it wrote one (ob 1745). A shot with a metrics file sends it as `metrics`.
 * A shot the server already holds (`byHash`, PS-424) names the image by `meta.sha256` and sends no `file`.
 */
export function snapshotForm(
  e: SnapshotEntry,
  png: Buffer,
  { results, flake, note, metrics, byHash }: ShotExtras,
): FormData {
  const form = new FormData();
  const meta: Record<string, unknown> = snapshotMeta(e);
  if (note) meta.changeNote = note;
  if (results.length > 0) {
    meta.ci = {
      engineVersion: ENGINE_VERSION,
      results: results.map(({ baselineId, status, diffResult }) => ({
        baselineId,
        status,
        diffResult,
      })),
    };
    for (const r of results)
      form.set(`diff:${r.baselineId}`, new File([new Uint8Array(r.mask)], "diff.png"));
  }
  if (flake?.flaky) {
    meta.flake = flake.record;
    for (const r of flake.retries)
      form.set(`flake:${r.run}`, new File([new Uint8Array(r.png)], `run${r.run}.png`));
  }
  if (byHash) meta.sha256 = byHash;
  form.set("meta", JSON.stringify(meta));
  if (!byHash) form.set("file", new File([new Uint8Array(png)], "shot.png"));
  if (metrics)
    form.set(
      "metrics",
      new File([new Uint8Array(metrics)], "metrics.json", { type: "application/json" }),
    );
  return form;
}

function snapshotMeta(e: SnapshotEntry) {
  return {
    name: e.name,
    platform: serverPlatform(e),
    browser: serverBrowser(e),
    viewport: `${e.variant.viewport.width}x${e.variant.viewport.height}`,
    theme: e.variant.theme,
    tags: e.tags,
    diff: e.diff,
    ignore: e.ignore,
    fingerprint: e.fingerprint,
    flaky: e.flaky,
    ...(e.composition && { composition: e.composition }),
    ...(e.a11y && { a11y: e.a11y }),
  };
}
