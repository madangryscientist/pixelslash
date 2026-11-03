import { UsageError } from "@hackcove/pixelslash-engine";
import type { Mismatch, StaleDeclaration } from "@hackcove/pixelslash-engine/parity";
import type { ParityManifest, ParityPlatform } from "@hackcove/pixelslash-engine/parity-manifest";
import { RemoteError, isObj, objects, str, type FetchLike } from "./api.ts";
import { DRIFT_EXIT, comparePairs, driftLines, pairsOf, type PairResult } from "./parity-pairs.ts";
import type { Remote } from "./remote.ts";

/** A stale twin as the server reports it (`GET /api/v1/projects/:id/stale`). */
export type StaleEntry = {
  name: string;
  theme: string;
  platform: string;
  /** The sentence to print: the key, the web build behind it, who accepted it and when. */
  sentence: string;
  cause: Record<string, unknown>;
  shots: Record<string, unknown>[];
};

/**
 * What `parity --release` found (PS-297): the stale twins of a native platform and the drift
 * among its accepted baseline pairs. Self-describing: `ok` is the verdict, `exit_code` the code
 * the command exits with.
 */
export type ReleaseReport = {
  release: ParityPlatform;
  project: { id: string; name: string };
  manifest: string | null;
  ok: boolean;
  exit_code: number;
  stale: number;
  drifting: number;
  /** Baseline pairs with both metrics files, compared. */
  pairs_checked: number;
  /** Baseline pairs with no metrics file on a side: not measured, never drift. */
  not_measured: number;
  /** Everything that fails the check, one entry each: a stale twin or a drifting baseline pair. */
  findings: ReleaseFinding[];
  stale_twins: StaleEntry[];
  results: PairResult[];
  stale_declarations: StaleDeclaration[];
};

/** One reason the release check fails: `kind` says which fields it carries. */
export type ReleaseFinding =
  | {
      kind: "stale";
      name: string;
      theme: string;
      platform: string;
      sentence: string;
      cause: Record<string, unknown>;
    }
  | {
      kind: "drift";
      name: string;
      theme: string;
      platform: string;
      sentence: string | null;
      mismatches: Mismatch[];
    };

export const RELEASE_PLATFORMS = ["android", "ios"] as const;

/** `--release`'s value: a native platform, else a usage error. */
export function releasePlatform(raw: string): (typeof RELEASE_PLATFORMS)[number] {
  const hit = RELEASE_PLATFORMS.find((p) => p === raw);
  if (!hit) throw new UsageError(`--release must be android or ios (got "${raw}")`);
  return hit;
}

const staleEntryOf = (e: Record<string, unknown>): StaleEntry => ({
  name: str(e.name),
  theme: str(e.theme),
  platform: str(e.platform),
  sentence: str(e.sentence),
  cause: isObj(e.cause) ? e.cause : {},
  shots: objects(e.shots),
});

/** The release check of one native platform: stale twins, and drift among the accepted baselines. */
export async function releaseReport(
  remote: Remote,
  fetch: FetchLike,
  target: {
    project: { id: string; name: string };
    platform: (typeof RELEASE_PLATFORMS)[number];
    manifest: ParityManifest;
    label: string | null;
  },
): Promise<ReleaseReport> {
  const { project, platform } = target;
  const path = `/api/v1/projects/${encodeURIComponent(project.id)}/stale`;
  const { body } = await remote.client.get(path, { platform });
  if (!Array.isArray(body.stale)) throw new RemoteError(`GET ${path}: no stale list in the answer`);
  const stale_twins = objects(body.stale).map(staleEntryOf);
  const { results, stale_declarations } = await comparePairs(
    remote,
    fetch,
    pairsOf(isObj(body.baselines) ? body.baselines : undefined),
    target.manifest,
  );
  const drifting = results.filter((r) => r.status === "drift").length;
  const not_measured = results.filter((r) => r.status === "not_measured").length;
  const ok = stale_twins.length === 0 && drifting === 0;
  return {
    release: platform,
    project,
    manifest: target.label,
    ok,
    exit_code: ok ? 0 : DRIFT_EXIT,
    stale: stale_twins.length,
    drifting,
    pairs_checked: results.length - not_measured,
    not_measured,
    findings: [
      ...stale_twins.map((s) => ({
        kind: "stale" as const,
        name: s.name,
        theme: s.theme,
        platform: s.platform,
        sentence: s.sentence,
        cause: s.cause,
      })),
      ...results
        .filter((r) => r.status === "drift")
        .map((r) => ({
          kind: "drift" as const,
          name: r.name,
          theme: r.theme,
          platform,
          sentence: r.line,
          mismatches: r.mismatches,
        })),
    ],
    stale_twins,
    results,
    stale_declarations,
  };
}

/** The text `parity --release` prints: a sentence per stale twin, a line per drifting pair, a count. */
export function releaseText(report: ReleaseReport): string {
  const lines = [...report.stale_twins.map((s) => s.sentence), ...driftLines(report.results)];
  for (const s of report.stale_declarations) lines.push(s.sentence);
  lines.push(
    `release ${report.release}: ${report.stale} stale, ${report.drifting} drifting, ${report.pairs_checked} pairs checked`,
  );
  return `${lines.join("\n")}\n`;
}
