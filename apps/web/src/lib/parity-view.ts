import type { StaleCause } from "./stale";
import { type Platform, type TwinSource, twinLabel, unlinkedLine } from "./twins";

// The parity view (PS-298): one snapshot key (name + theme) on web, android and ios side by side.
// Pure words and shapes, so the server function, the API and the screen say the same thing;
// `server/parity-view.ts` is the one that builds it. Everything here is a hint or a reading of
// stored files: nothing in it changes a status, an exit code, a check or a count.

/** What a pair or a column without a metrics file says. It is never drift (PS-296). */
export const NOT_MEASURED = "not measured";

/** What a pair the similarity hint cannot score says. It is never 0. */
export const NO_SCORE = "no score";

/**
 * The manifest is kept in the repo today and the server has no store for it (PS-298), so the view
 * compares the stored metrics files with no declaration applied and says so.
 */
export const MANIFEST_NOTICE =
  "The parity manifest is kept in the repo, not on the server: declared differences and allowed colours are not applied here, so a mismatch below may be one the manifest accepts. `pixelslash parity` gives the verdict.";

/** The hint beside a native column: `similarity 0.93, a hint: fonts render differently by design`. */
export function similarityText(score: number | null): string {
  if (score === null) return NO_SCORE;
  return `similarity ${score.toFixed(2)}, a hint: fonts render differently by design`;
}

/** The scale a shot is read at, in words: `3x`, or `1x (not recorded)` when its upload carried none. */
export function scaleText(scale: number | null): string {
  return scale === null ? "1x (not recorded)" : `${scale}x`;
}

/** The physical (logical px) size of a shot: its pixels divided by its scale. */
export function physicalSize(
  size: { width: number; height: number } | null,
  scale: number | null,
): { width: number; height: number } | null {
  if (!size) return null;
  const s = scale ?? 1;
  const round = (n: number) => Math.round((n / s) * 100) / 100;
  return { width: round(size.width), height: round(size.height) };
}

/** Where a shot is reached: the same page the build's list links to. */
export type ParityShotRef = {
  snapshotId: string;
  buildId: string;
  projectId: string;
  projectName: string;
};

export type ParityShotColumn = ParityShotRef & {
  kind: "shot";
  platform: Platform;
  device: string | null;
  viewport: string;
  /** `android · Pixel 8`, or `web`. */
  label: string;
  source: TwinSource;
  /** The scale the upload recorded; null for web and for a shot that carried none. */
  scale: number | null;
  /** The shot's pixels and its logical size (pixels / scale); null on a shot uploaded before sizes were kept. */
  size: { width: number; height: number } | null;
  physical: { width: number; height: number } | null;
  imageUrl: string;
  /** PS-297: the web change this native shot has not been reviewed against. */
  stale: StaleCause | null;
  hasMetrics: boolean;
  /** The hint against the reference web column; null on a web column. */
  similarity: ParitySimilarity | null;
};

/** A platform with no shot under the key. The column stays: nothing is hidden. */
export type ParityMissingColumn = {
  kind: "missing";
  platform: Platform;
  /** `Button/loading dark has no android twin`, as the build's Unlinked list words it. */
  line: string;
};

export type ParityColumn = ParityShotColumn | ParityMissingColumn;

export type ParitySimilarity = {
  /** The web column the score is against; stated because a key may have several. Null with no web shot. */
  against: (ParityShotRef & { label: string }) | null;
  /** In [0, 1]; null when the pair could not be scored. */
  score: number | null;
  text: string;
};

export type ParityPairSide = { snapshotId: string; platform: Platform; label: string };

export type ParityPairView = {
  a: ParityPairSide;
  b: ParityPairSide;
  status: "clean" | "drift" | "not_measured";
  /** The platforms with no metrics file, when the pair is not measured. */
  lacks: Platform[];
  /** The pair's mismatches, as the sentences `pixelslash parity` prints. */
  mismatches: string[];
  /** Differences the manifest declares on purpose; empty without a manifest. */
  declared: string[];
  tolerance: number | null;
};

/** One part's value of one field in each column, `null` where that shot did not measure it. */
export type ParityRawRow = {
  part: string;
  field: string;
  values: (string | null)[];
};

export type ParityMetricsView = {
  /** Whether the project's manifest was applied. False today: the server keeps none. */
  manifest: boolean;
  /** One line saying so, when it was not. */
  notice: string | null;
  pairs: ParityPairView[];
  /** The shots that have metrics, in column order: the columns of `raw`. */
  rawColumns: (ParityPairSide & { measured: boolean })[];
  raw: ParityRawRow[];
};

export type ParityView = {
  name: string;
  theme: string;
  /** Web, android and ios, in that order; each platform with no shot is one `missing` column. */
  columns: ParityColumn[];
  metrics: ParityMetricsView;
};

/** The missing column of a platform, worded as the Unlinked list words it. */
export function missingColumn(
  name: string,
  theme: string,
  platform: Platform,
): ParityMissingColumn {
  return { kind: "missing", platform, line: unlinkedLine({ name, theme, missing: [platform] }) };
}

export const pairSideOf = (c: {
  snapshotId: string;
  platform: Platform;
  device: string | null;
}): ParityPairSide => ({
  snapshotId: c.snapshotId,
  platform: c.platform,
  label: twinLabel(c),
});

/** `web vs android · Pixel 8`: a pair named by its two sides. */
export const pairLabel = (p: Pick<ParityPairView, "a" | "b">): string =>
  `${p.a.label} vs ${p.b.label}`;
