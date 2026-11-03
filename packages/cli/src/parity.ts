import { resolve } from "node:path";
import { UsageError } from "@hackcove/pixelslash-engine";
import { parseMetricsText, type Metrics } from "@hackcove/pixelslash-engine/metrics-entry";
import {
  compareParity,
  staleDeclarations,
  type Mismatch,
  type ParityPair,
  type StaleDeclaration,
} from "@hackcove/pixelslash-engine/parity";
import {
  EMPTY_MANIFEST,
  PARITY_PLATFORMS,
  parseParityManifest,
  type ParityManifest,
  type ParityPlatform,
} from "@hackcove/pixelslash-engine/parity-manifest";
import { REMOTE_EXIT, RemoteError, fetchBlob, isObj, objects, str, type FetchLike } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import { connect, type Remote, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";

/** Drift between twins. Exit 1 stays the new-violations code (invariant 3) and 7 the crash path. */
export const DRIFT_EXIT = 8;

/** The manifest `parity` reads when `--manifest` is not given and the file is in the cwd. */
export const DEFAULT_MANIFEST = "pixelslash.parity.json";

export const PARITY_USAGE = `pixelslash parity --build ID [--manifest PATH] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
Compares the layout metrics of every twin pair in the build (docs/metrics.md). --manifest defaults to ${DEFAULT_MANIFEST} in the cwd when it exists.
Exit 0 no drift (a pair without a metrics file is "not measured", never drift), ${DRIFT_EXIT} drift, ${REMOTE_EXIT} the server did not answer, 2 usage or a malformed manifest.`;

const FLAGS = ["build", "manifest", "server", "token-path", "project", "config"] as const;

type Side = {
  platform: ParityPlatform;
  snapshot_id: string;
  device: string;
  viewport: string;
};

type Loaded = { side: Side; scale: number | null; metrics: Metrics };

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

export type ParityReport = {
  build: string;
  /** The manifest read, or null when none was given or found. */
  manifest: string | null;
  pairs: number;
  drift: number;
  not_measured: number;
  results: PairResult[];
  stale_declarations: StaleDeclaration[];
};

/** `--manifest`, else `pixelslash.parity.json` in the cwd when it exists, else no allowances. */
export async function loadManifest(
  flag: string | undefined,
  cwd: string,
): Promise<{ path: string | null; manifest: ParityManifest }> {
  const path = resolve(cwd, flag ?? DEFAULT_MANIFEST);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (flag !== undefined) throw new UsageError(`--manifest ${flag}: no such file`);
    return { path: null, manifest: EMPTY_MANIFEST };
  }
  const label = flag ?? DEFAULT_MANIFEST;
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new UsageError(`${label}: not valid JSON`);
  }
  const manifest = parseParityManifest(json, "manifest", (where, what) => {
    throw new UsageError(`${label}: ${where} ${what}`);
  });
  return { path: label, manifest };
}

const platformOf = (v: unknown): ParityPlatform | undefined =>
  PARITY_PLATFORMS.find((p) => p === v);

function sideOf(e: Record<string, unknown>): Side | undefined {
  const platform = platformOf(e.platform);
  const snapshot_id = str(e.snapshot_id);
  if (!platform || !snapshot_id) return undefined;
  return { platform, snapshot_id, device: str(e.device), viewport: str(e.viewport) };
}

/** Every twin pair across platforms in the build's `twins` section, each once. */
function pairsOf(
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

/** Reads the build, fetches each pair's two metrics files and compares them. */
export async function parityReport(
  remote: Remote,
  fetch: FetchLike,
  build: string,
  loaded: { manifest: ParityManifest; label: string | null },
): Promise<ParityReport> {
  const { manifest, label: manifestLabel } = loaded;
  const reply = await remote.client.get(`/api/v1/builds/${encodeURIComponent(build)}`);
  if (!isObj(reply.body.build))
    throw new RemoteError(`GET /api/v1/builds/${build}: no build in the answer`);
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
  for (const p of pairsOf(reply.body.build.twins)) {
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
  return {
    build,
    manifest: manifestLabel,
    pairs: results.length,
    drift: results.filter((r) => r.status === "drift").length,
    not_measured: results.filter((r) => r.status === "not_measured").length,
    results,
    stale_declarations: staleDeclarations(compared),
  };
}

const key = (r: PairResult) => `${r.name} ${r.theme}`;

const where = (s: PairResult["sides"][number]) =>
  [s.platform, s.device, s.viewport].filter(Boolean).join(" ");

/** The text `parity` prints: a line per drifting pair, what was not measured, stale declarations, a count. */
export function parityText(report: ParityReport): string {
  if (report.pairs === 0) return "parity: no twins\n";
  const lines: string[] = [];
  const several = (r: PairResult) => report.results.filter((o) => key(o) === key(r)).length > 1;
  for (const r of report.results) {
    if (r.status === "drift" && r.line !== null) {
      // Two pairs of one snapshot would read the same; say which shots.
      const head = `${key(r)}: `;
      lines.push(
        several(r)
          ? `${key(r)} (${r.sides.map(where).join(" vs ")}): ${r.line.slice(head.length)}`
          : r.line,
      );
    }
  }
  for (const r of report.results)
    if (r.status === "not_measured")
      lines.push(
        `not measured: ${key(r)}${several(r) ? ` (${r.sides.map(where).join(" vs ")})` : ""} (${r.lacks.join(" and ")} has no metrics file)`,
      );
  for (const s of report.stale_declarations) lines.push(s.sentence);
  const drift = `${report.drift} with drift`;
  lines.push(`parity: ${report.pairs} pairs, ${drift}, ${report.not_measured} not measured`);
  return `${lines.join("\n")}\n`;
}

export async function runParity(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const flags = readFlagPairs(rest, FLAGS);
  if (!flags.build) throw new UsageError("need --build ID");
  // The manifest first: a malformed one is a usage error before any request goes out.
  const { path, manifest } = await loadManifest(flags.manifest, deps.cwd ?? process.cwd());
  const remote = await connect(flags, deps);
  const report = await parityReport(remote, deps.fetch ?? fetch, flags.build, {
    manifest,
    label: path,
  });
  io.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : parityText(report));
  return report.drift > 0 ? DRIFT_EXIT : 0;
}
