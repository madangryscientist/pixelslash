import { resolve } from "node:path";
import { UsageError } from "@hackcove/pixelslash-engine";
import type { StaleDeclaration } from "@hackcove/pixelslash-engine/parity";
import {
  EMPTY_MANIFEST,
  parseParityManifest,
  type ParityManifest,
} from "@hackcove/pixelslash-engine/parity-manifest";
import { REMOTE_EXIT, RemoteError, isObj, type FetchLike } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import {
  DRIFT_EXIT,
  comparePairs,
  driftLines,
  key,
  pairsOf,
  where,
  type PairResult,
} from "./parity-pairs.ts";
import { releasePlatform, releaseReport, releaseText } from "./parity-release.ts";
import { connect, resolveProject, type Remote, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";

/** The manifest `parity` reads when `--manifest` is not given and the file is in the cwd. */
export const DEFAULT_MANIFEST = "pixelslash.parity.json";

export const PARITY_USAGE = `pixelslash parity --build ID [--manifest PATH] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash parity --release android|ios [--project ID|NAME] [--manifest PATH] [--server URL] [--token-path PATH] [--config FILE] [--json]
--build compares the layout metrics of every twin pair in the build (docs/metrics.md). --manifest defaults to ${DEFAULT_MANIFEST} in the cwd when it exists.
--release is the release check for one native platform: it fails on any stale twin (a web change nobody has accepted on that platform since, docs/cli.md) and on any drifting pair of accepted baselines. It cannot be combined with --build.
Exit 0 no drift (a pair without a metrics file is "not measured", never drift) and, under --release, nothing stale; ${DRIFT_EXIT} drift or a stale twin; ${REMOTE_EXIT} the server did not answer, 2 usage or a malformed manifest.`;

const FLAGS = [
  "build",
  "release",
  "manifest",
  "server",
  "token-path",
  "project",
  "config",
] as const;

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
  const manifest = parseParityManifest(json, "manifest", (at, what) => {
    throw new UsageError(`${label}: ${at} ${what}`);
  });
  return { path: label, manifest };
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
  const { results, stale_declarations } = await comparePairs(
    remote,
    fetch,
    pairsOf(reply.body.build.twins),
    manifest,
  );
  return {
    build,
    manifest: manifestLabel,
    pairs: results.length,
    drift: results.filter((r) => r.status === "drift").length,
    not_measured: results.filter((r) => r.status === "not_measured").length,
    results,
    stale_declarations,
  };
}

/** The text `parity` prints: a line per drifting pair, what was not measured, stale declarations, a count. */
export function parityText(report: ParityReport): string {
  if (report.pairs === 0) return "parity: no twins\n";
  const lines = driftLines(report.results);
  const several = (r: PairResult) => report.results.filter((o) => key(o) === key(r)).length > 1;
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

async function runRelease(
  flags: Partial<Record<(typeof FLAGS)[number], string>>,
  json: boolean,
  io: Io,
  deps: RemoteDeps,
): Promise<number> {
  const platform = releasePlatform(flags.release ?? "");
  // The manifest first: a malformed one is a usage error before any request goes out.
  const { path, manifest } = await loadManifest(flags.manifest, deps.cwd ?? process.cwd());
  const remote = await connect(flags, deps);
  const project = await resolveProject(remote, flags.project);
  const report = await releaseReport(remote, deps.fetch ?? fetch, {
    project: { id: project.id, name: project.name },
    platform,
    manifest,
    label: path,
  });
  io.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : releaseText(report));
  return report.exit_code;
}

export async function runParity(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const flags = readFlagPairs(rest, FLAGS);
  if (flags.release !== undefined) {
    if (flags.build !== undefined) throw new UsageError("--release and --build cannot be combined");
    return runRelease(flags, json, io, deps);
  }
  if (!flags.build) throw new UsageError("need --build ID or --release android|ios");
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
