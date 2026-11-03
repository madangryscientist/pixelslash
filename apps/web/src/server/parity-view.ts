import type { Metrics } from "@hackcove/pixelslash-engine/metrics-entry";
import { compareParity } from "@hackcove/pixelslash-engine/parity";
import { LABELS, read } from "@hackcove/pixelslash-engine/parity-fields";
import {
  EMPTY_MANIFEST,
  PARITY_FIELDS,
  type ParityManifest,
} from "@hackcove/pixelslash-engine/parity-manifest";
import { similarityOfPngs } from "@hackcove/pixelslash-engine/similarity-png";
import type { ParityColumns, ParityShot } from "#/db/parity-columns";
import {
  MANIFEST_NOTICE,
  type ParityColumn,
  type ParityPairView,
  type ParityRawRow,
  type ParityShotColumn,
  type ParitySimilarity,
  type ParityView,
  missingColumn,
  pairSideOf,
  physicalSize,
  similarityText,
} from "#/lib/parity-view";
import { PLATFORMS, twinLabel } from "#/lib/twins";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { loadMetrics } from "./metrics-read";

/**
 * The parity view of one snapshot key (PS-298): the shots side by side at one physical size, the
 * metrics comparison of PS-296 under them, and a similarity hint per native column. A read: it
 * stores nothing, and the hint is shown and nothing else, so no status, check or count can see it.
 */

type Input = {
  columns: ParityColumns;
  orgId: string;
  store: BlobStore;
  /** A link to one of the org's blobs, signed for whoever the view goes to. */
  sign: (key: string) => Promise<string>;
  /**
   * The project's parity manifest, when the caller has one. The server keeps none today (the file
   * is repo-kept), so a caller leaves it out and the view says so; tests and a future store pass it.
   */
  manifest?: ParityManifest;
};

async function bytesOf(store: BlobStore, orgId: string, key: string): Promise<Uint8Array | null> {
  try {
    const body = await orgBlobs(store, orgId).get(key);
    return body ? new Uint8Array(await new Response(body).arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const refOf = (s: ParityShot) => ({
  snapshotId: s.snapshotId,
  buildId: s.buildId,
  projectId: s.projectId,
  projectName: s.projectName,
});

/** The score of each native shot against the first web shot: a hint, `null` when it cannot be scored. */
async function hints(
  input: Input,
  reference: ParityShot | undefined,
): Promise<Map<string, ParitySimilarity>> {
  const out = new Map<string, ParitySimilarity>();
  const against = reference ? { ...refOf(reference), label: twinLabel(reference) } : null;
  const refBytes = reference && (await bytesOf(input.store, input.orgId, reference.imageKey));
  for (const shot of input.columns.shots) {
    if (shot.platform === "web") continue;
    const bytes = refBytes && (await bytesOf(input.store, input.orgId, shot.imageKey));
    const score =
      reference && refBytes && bytes
        ? similarityOfPngs(
            { png: refBytes, scale: reference.scale },
            { png: bytes, scale: shot.scale },
          )
        : null;
    out.set(shot.snapshotId, { against, score, text: similarityText(score) });
  }
  return out;
}

const text = (v: number | string | undefined): string | null =>
  v === undefined ? null : String(v);

/** Every part and field either shot measured, as one row of numbers across the columns. */
function rawRows(shots: ParityShot[], metrics: Map<string, Metrics>): ParityRawRow[] {
  const parts = new Set(shots.flatMap((s) => Object.keys(metrics.get(s.snapshotId)?.parts ?? {})));
  const rows: ParityRawRow[] = [];
  for (const part of parts)
    for (const field of PARITY_FIELDS) {
      const values = shots.map((s) => {
        const p = metrics.get(s.snapshotId)?.parts[part];
        return p ? text(read(p, field)) : null;
      });
      if (values.some((v) => v !== null)) rows.push({ part, field: LABELS[field], values });
    }
  return rows;
}

/** Each cross-platform pair of the key's shots once, compared when both have a metrics file. */
function pairsOf(
  input: Input,
  metrics: Map<string, Metrics>,
  manifest: ParityManifest,
): ParityPairView[] {
  const { shots, name, theme } = input.columns;
  const pairs: ParityPairView[] = [];
  for (const [i, a] of shots.entries())
    for (const b of shots.slice(i + 1)) {
      if (a.platform === b.platform) continue;
      const [ma, mb] = [metrics.get(a.snapshotId), metrics.get(b.snapshotId)];
      const sides = { a: pairSideOf(a), b: pairSideOf(b) };
      if (!ma || !mb) {
        pairs.push({
          ...sides,
          status: "not_measured",
          lacks: [...(ma ? [] : [a.platform]), ...(mb ? [] : [b.platform])],
          mismatches: [],
          declared: [],
          tolerance: null,
        });
        continue;
      }
      const pair = compareParity({
        name,
        theme,
        a: { platform: a.platform, scale: a.scale, metrics: ma },
        b: { platform: b.platform, scale: b.scale, metrics: mb },
        manifest,
      });
      pairs.push({
        ...sides,
        status: pair.mismatches.length > 0 ? "drift" : "clean",
        lacks: [],
        mismatches: pair.mismatches.map((m) => m.sentence),
        declared: pair.declared.map((m) => m.sentence),
        tolerance: pair.tolerance,
      });
    }
  return pairs;
}

export async function buildParityView(input: Input): Promise<ParityView> {
  const { name, theme, shots } = input.columns;
  const manifest = input.manifest ?? EMPTY_MANIFEST;
  const reference = shots.find((s) => s.platform === "web");
  const scores = await hints(input, reference);

  const metrics = new Map<string, Metrics>();
  for (const shot of shots) {
    const loaded = await loadMetrics(input.store, input.orgId, shot.metricsKey);
    if (loaded) metrics.set(shot.snapshotId, loaded);
  }

  const columns: ParityColumn[] = [];
  for (const platform of PLATFORMS) {
    const here = shots.filter((s) => s.platform === platform);
    if (here.length === 0) columns.push(missingColumn(name, theme, platform));
    for (const shot of here) {
      const column: ParityShotColumn = {
        ...refOf(shot),
        kind: "shot",
        platform: shot.platform,
        device: shot.device,
        viewport: shot.viewport,
        label: twinLabel(shot),
        source: shot.source,
        scale: shot.scale,
        size: shot.size,
        physical: physicalSize(shot.size, shot.scale),
        imageUrl: await input.sign(shot.imageKey),
        stale: shot.stale,
        hasMetrics: metrics.has(shot.snapshotId),
        similarity: scores.get(shot.snapshotId) ?? null,
      };
      columns.push(column);
    }
  }

  return {
    name,
    theme,
    columns,
    metrics: {
      manifest: input.manifest !== undefined,
      notice: input.manifest === undefined ? MANIFEST_NOTICE : null,
      pairs: pairsOf(input, metrics, manifest),
      rawColumns: shots.map((s) => ({ ...pairSideOf(s), measured: metrics.has(s.snapshotId) })),
      raw: rawRows(shots, metrics),
    },
  };
}
