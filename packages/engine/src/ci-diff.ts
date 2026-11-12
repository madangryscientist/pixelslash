import { type DiffSummary, ENGINE_VERSION, measurePngs, summarizeDiff } from "./diff.ts";
import type { MaskRect } from "./config-areas.ts";
import type { SnapshotEntry } from "./snapshot.ts";

/**
 * The CLI's half of a project that diffs in CI (ob 1727). The server picks each shot's baseline
 * (`POST /api/v1/builds/:id/baselines`) and this measures the shot against it, with the same
 * engine the server's own diff runs, so it can check and store the result without decoding a PNG.
 * Nothing here picks a baseline: the server does. Deciding a carry, which compares environments, is
 * `check`'s `settle()`, which mirrors the server's `diffOne`.
 */

export type DiffLocation = "ci" | "server";

/** One baseline as the server returns it. */
export type PickedShot = {
  id: string;
  image_url: string;
  fingerprint: unknown;
  ignore: MaskRect[];
  /**
   * The sha256 of the baseline's PNG, as the server stored it. Absent from a server that does not
   * send it, and null for a baseline stored before the server hashed uploads: either way the
   * baseline is fetched, as it always was.
   */
  sha256?: string | null;
};

/** The server's pick for one shot key. */
export type BaselinePick = {
  baseline: PickedShot | null;
  /** Set when `baseline` holds an undecided change (ob 1712); `accepted` is then the fallback. */
  carry: string | null;
  accepted: PickedShot | null;
};

function isPicked(v: unknown): v is PickedShot | null {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  const { id, image_url, ignore } = { id: null, image_url: null, ignore: null, ...v };
  return typeof id === "string" && typeof image_url === "string" && Array.isArray(ignore);
}

/** One entry of the server's reply, checked before the CLI fetches what it names. */
export function isBaselinePick(v: unknown): v is BaselinePick {
  if (typeof v !== "object" || v === null) return false;
  const { baseline, carry, accepted } = { baseline: null, carry: null, accepted: null, ...v };
  return isPicked(baseline) && isPicked(accepted) && (carry === null || typeof carry === "string");
}

/** What the server stores per baseline measured against: the result and its mask beside it. */
export type CiResult = {
  baselineId: string;
  status: "changed" | "unchanged";
  diffResult: DiffSummary;
  mask: Buffer;
};

/** What of a manifest entry the measure reads: its options and its ignore areas. */
export type MeasuredShot = Pick<SnapshotEntry, "diff" | "ignore">;

function measure(shot: MeasuredShot, png: Buffer, picked: PickedShot, main: Buffer): CiResult {
  // Always measured, never the identical-bytes shortcut: the upload carries a mask for every result.
  const result = measurePngs(main, png, shot.diff, { main: picked.ignore, branch: shot.ignore });
  return {
    baselineId: picked.id,
    status: result.changed ? "changed" : "unchanged",
    diffResult: summarizeDiff(result),
    mask: result.overlay,
  };
}

/**
 * Measure a shot against every shot the server named: `baseline`, and `accepted` when it is
 * another one. Whether the environments match and which way a carry falls stay the server's call;
 * finalise reads the result for the baseline it settles on and ignores the other. At most two.
 */
export async function measureShot(
  shot: MeasuredShot,
  png: Buffer,
  pick: BaselinePick,
  fetchPng: (picked: PickedShot) => Promise<Buffer>,
): Promise<CiResult[]> {
  const named = [pick.baseline, pick.accepted].filter((p): p is PickedShot => p !== null);
  const distinct = named.filter((p, i) => named.findIndex((q) => q.id === p.id) === i);
  const results: CiResult[] = [];
  for (const picked of distinct) results.push(measure(shot, png, picked, await fetchPng(picked)));
  return results;
}

/**
 * The pick without the shots that are this PNG's own bytes (same sha256, known only when the server
 * sent one). Such a shot is unchanged by definition, so nothing is fetched or diffed for it; the
 * same pick comes back when none is. A null or absent hash never matches.
 */
export function withoutSame(pick: BaselinePick, sha256: string): BaselinePick {
  const same = (p: PickedShot | null) =>
    p !== null && typeof p.sha256 === "string" && p.sha256 === sha256;
  if (!same(pick.baseline) && !same(pick.accepted)) return pick;
  return {
    ...pick,
    baseline: same(pick.baseline) ? null : pick.baseline,
    accepted: same(pick.accepted) ? null : pick.accepted,
  };
}

export { ENGINE_VERSION };
