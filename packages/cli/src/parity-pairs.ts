import { parseMetricsText, type Metrics } from "@hackcove/pixelslash-engine/metrics-entry";
import {
  compareParity,
  staleDeclarations,
  type Mismatch,
  type ParityPair,
  type StaleDeclaration,
} from "@hackcove/pixelslash-engine/parity";
import {
  PARITY_PLATFORMS,
  type ParityManifest,
  type ParityPlatform,
} from "@hackcove/pixelslash-engine/parity-manifest";
import { RemoteError, fetchBlob, isObj, objects, str, type FetchLike } from "./api.ts";
import type { Remote } from "./remote.ts";

/** Drift between twins. Exit 1 stays the new-violations code (invariant 3) and 7 the crash path. */
export const DRIFT_EXIT = 8;

export type Side = {
  platform: ParityPlatform;
  snapshot_id: string;
  device: string;
  viewport: string;
};

export type Loaded = { side: Side; scale: number | null; metrics: Metrics };

export type PairResult = {
  name: string;
  theme: string;
  status: "clean" | "drift" | "not_measured";
  sides: (Side & { scale: number | null; scale_source: "recorded" | "default" | null })[];
  /** The platforms with no metrics file, when the pair is not measured. */
  lacks: ParityPlatform[];
  tolerance: number | null;
  mismatches: Mismatch[];
  declared: Mismatch[];
  line: string | null;
};

const platformOf = (v: unknown): ParityPlatform | undefined =>
  PARITY_PLATFORMS.find((p) => p === v);

function sideOf(e: Record<string, unknown>): Side | undefined {
  const platform = platformOf(e.platform);
  const snapshot_id = str(e.snapshot_id);
  if (!platform || !snapshot_id) return undefined;
  return { platform, snapshot_id, device: str(e.device), viewport: str(e.viewport) };
}

/** Every twin pair across platforms in the build's `twins` section, each once. */
export function pairsOf(
  twins: unknown,
): { name: string; theme: string; a: Side; b: Side; hasA: boolean; hasB: boolean }[] {
  if (!isObj(twins)) return [];
  const seen = new Set<string>();
  const out: ReturnType<typeof pairsOf> = [];
  for (const e of objects(twins.linked)) {
    const a = sideOf(e);
    if (!a) continue;
    for (const t of objects(e.twins)) {
      const b = sideOf(t);
      if (!b || b.platform === a.platform) continue;
      const key = [a.snapshot_id, b.snapshot_id].toSorted().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: str(e.name),
        theme: str(e.theme),
        a,
        b,
        hasA: e.has_metrics === true,
        hasB: t.has_metrics === true,
      });
    }
  }
  return out;
}

/** The metrics file a signed URL names, only from the configured server. */
async function fetchMetrics(remote: Remote, fetch: FetchLike, url: string, name: string) {
  const bytes = new Uint8Array(await fetchBlob(remote.client.server, fetch, url));
  return parseMetricsText(
    new TextDecoder().decode(bytes),
    name,
    (where, what) => {
      throw new RemoteError(`${where} ${what}`);
    },
    bytes.byteLength,
  );
}

async function loadSide(remote: Remote, fetch: FetchLike, side: Side): Promise<Loaded> {
  const { body } = await remote.client.get(
    `/api/v1/snapshots/${encodeURIComponent(side.snapshot_id)}`,
  );
  const shot = body.snapshot;
  if (!isObj(shot))
    throw new RemoteError(`GET /api/v1/snapshots/${side.snapshot_id}: no snapshot in the answer`);
  const scale = typeof shot.scale === "number" ? shot.scale : null;
  const url = str(shot.metrics_url);
  if (!url)
    throw new RemoteError(`snapshot ${side.snapshot_id} has metrics but the server sent no URL`);
  const metrics = await fetchMetrics(remote, fetch, url, `metrics of snapshot ${side.snapshot_id}`);
  return { side, scale, metrics };
}

function infos(pair: ParityPair, a: Side, b: Side): PairResult["sides"] {
  return pair.sides.map((s) => {
    const side = s.platform === a.platform ? a : b;
    return { ...side, scale: s.scale, scale_source: s.scale_source };
  });
}

type Linked = ReturnType<typeof pairsOf>;

/** Fetches each pair's two metrics files and compares them; a pair without a file is not measured. */
export async function comparePairs(
  remote: Remote,
  fetch: FetchLike,
  pairs: Linked,
  manifest: ParityManifest,
): Promise<{ results: PairResult[]; stale_declarations: StaleDeclaration[] }> {
  const cache = new Map<string, Promise<Loaded>>();
  const load = (side: Side) => {
    const cached = cache.get(side.snapshot_id);
    if (cached) return cached;
    const p = loadSide(remote, fetch, side);
    cache.set(side.snapshot_id, p);
    return p;
  };
  const results: PairResult[] = [];
  const compared: ParityPair[] = [];
  for (const p of pairs) {
    const lacks = [...(p.hasA ? [] : [p.a.platform]), ...(p.hasB ? [] : [p.b.platform])];
    if (lacks.length > 0) {
      results.push({
        name: p.name,
        theme: p.theme,
        status: "not_measured",
        sides: [p.a, p.b].map((s) => ({ ...s, scale: null, scale_source: null })),
        lacks,
        tolerance: null,
        mismatches: [],
        declared: [],
        line: null,
      });
      continue;
    }
    const [la, lb] = [await load(p.a), await load(p.b)];
    const pair = compareParity({
      name: p.name,
      theme: p.theme,
      a: { platform: p.a.platform, scale: la.scale, metrics: la.metrics },
      b: { platform: p.b.platform, scale: lb.scale, metrics: lb.metrics },
      manifest,
    });
    compared.push(pair);
    results.push({
      name: p.name,
      theme: p.theme,
      status: pair.mismatches.length > 0 ? "drift" : "clean",
      sides: infos(pair, p.a, p.b),
      lacks: [],
      tolerance: pair.tolerance,
      mismatches: pair.mismatches,
      declared: pair.declared,
      line: pair.line,
    });
  }
  return { results, stale_declarations: staleDeclarations(compared) };
}

export const key = (r: PairResult) => `${r.name} ${r.theme}`;

export const where = (s: PairResult["sides"][number]) =>
  [s.platform, s.device, s.viewport].filter(Boolean).join(" ");

/** A line per drifting pair; two pairs of one snapshot would read the same, so those say which shots. */
export function driftLines(results: PairResult[]): string[] {
  const several = (r: PairResult) => results.filter((o) => key(o) === key(r)).length > 1;
  const lines: string[] = [];
  for (const r of results) {
    if (r.status !== "drift" || r.line === null) continue;
    const head = `${key(r)}: `;
    lines.push(
      several(r)
        ? `${key(r)} (${r.sides.map(where).join(" vs ")}): ${r.line.slice(head.length)}`
        : r.line,
    );
  }
  return lines;
}
