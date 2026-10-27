/* The JSON a snapshot row stores for its diff, as typed columns of `schema.ts`. */

/** The diff tolerance a snapshot is compared with; the same keys as the engine's `DiffOptions`. */
export type DiffOptions = {
  threshold?: number;
  minChangedPixels?: number;
  minChangedRatio?: number;
  mergeDistance?: number;
  minRegionArea?: number;
  noiseAmplitude?: number;
  maxShift?: number;
};

/**
 * Where one option's value came from (ob 1495): the uploaded config (its variant, route and project
 * layers, merged by the CLI), or a reviewer's override in the review UI, for the test or for one
 * variant of it. `by` is the GitHub login, `at` epoch ms.
 */
export type OptionSource =
  | { from: "config" }
  | { from: "ui"; scope: "test" | "variant"; by: string; at: number };

/**
 * The options a shot was measured with and where each came from (ob 1495). A key in neither the
 * config nor an override is left out, so the engine default applies to it.
 */
export type ResolvedDiff = {
  options: DiffOptions;
  sources: Partial<Record<keyof DiffOptions, OptionSource>>;
  /** Ignore boxes drawn in the review UI (ob 1499), on top of the shot's own; absent when none. */
  ignore?: UiIgnoreBox[];
};

/** A rectangle in image px that the diff skips; the same shape as the engine's `IgnoreRect`. */
export type IgnoreRect = { x: number; y: number; width: number; height: number };

/** An ignore box drawn in the review UI (ob 1499): its rect, scope, who drew it, when (epoch ms). */
export type UiIgnoreBox = IgnoreRect & {
  id: string;
  scope: "test" | "variant";
  by: string;
  at: number;
};

export type RegionKind = "change" | "noise" | "shift";

/** A box of differing pixels, the same shape as the engine's `Region` (ob 1486, 1487). */
export type DiffRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  changedPixels: number;
  antialiasedPixels: number;
  /** Only `change` blocks a build; a `noise` or `shift` box is kept for the reviewer. */
  kind: RegionKind;
  why?: string;
};

/**
 * What the diff measured for one snapshot, as stored. `null` means it was not compared: no
 * baseline (`new`), a removed shot, or a fingerprint that needs a re-baseline.
 */
export type DiffResult = {
  changedPixels: number;
  antialiasedPixels: number;
  /** Pixels of the overlap inside an ignore area: skipped, so neither changed nor unchanged. */
  ignoredPixels: number;
  ignored: IgnoreRect[];
  /** Boxes dropped below `minRegionArea`: counted, never silently lost. */
  specks: { count: number; pixels: number };
  regions: DiffRegion[];
  /** The overlap that was measured; `main*` and `branch*` are both shots, which may differ. */
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
  /** The shots are different sizes: `changed`, and only the overlap was measured. */
  sizeChanged: boolean;
  /** Set when the shots were the same bytes, so nothing was decoded or diffed (ob 1948). */
  settledBy?: "identical-bytes";
};

/** What the project's model said a `change` region is (ob 1473). */
export const AI_LABELS = ["intended", "unintended", "noise"] as const;
export type AiLabel = (typeof AI_LABELS)[number];

/** One `change` region the model explained, keyed by its box so it pairs with `regions`. */
export type AiRegionNote = {
  x: number;
  y: number;
  w: number;
  h: number;
  label: AiLabel;
  /** One short sentence: what changed in the region. */
  explanation: string;
};

/**
 * The model's account of a shot's `change` regions (ob 1473). It explains what the diff found and
 * never adds a region: a region it could not explain is left out, and a shot with none explained
 * stores no review at all, so the page says "skip: no judge".
 */
export type AiReview = {
  model: string;
  /** Epoch ms of the explanation. */
  at: number;
  regions: AiRegionNote[];
  /** The project opted in and every `change` region was labelled noise: accepted without a reviewer. */
  autoPassed: boolean;
  /** The tokens of the calls whose notes are stored (PS-233); absent on a review older than that. */
  usage?: AiUsage;
};

/**
 * The tokens a set of model calls spent (PS-233), as the endpoint's replies reported them: only calls
 * whose answer was stored are counted, never a failed one. `reported` of `calls` said their usage;
 * the sums cover those only, and with `reported` 0 they are null: no count was reported.
 */
export type AiUsage = {
  calls: number;
  reported: number;
  input: number | null;
  output: number | null;
  total: number | null;
};

/**
 * How long the CLI's steps took for a build (ob 1791), in whole milliseconds, as the CLI sent it at
 * finalize. A step the run did not do is absent, never 0. Numbers and shot names only.
 */
export type BuildTimings = {
  totalMs: number;
  captureMs?: number;
  diffMs?: number;
  judgeMs?: number;
  upload?: { totalMs: number; batches: { step: string; count: number; ms: number }[] };
  shots: { name: string; captureMs?: number; diffMs?: number; judgeMs?: number }[];
};

/** One sentence of a build's summary and the shots it describes, for links. */
export type AiSummarySentence = { text: string; shots: string[] };

/**
 * The project model's summary of a build (ob 1668): written from the stored measurements and region
 * notes, never from the images. It is text for the reviewer and decides nothing.
 */
export type AiSummary = {
  model: string;
  /** Epoch ms of the summary. */
  at: number;
  sentences: AiSummarySentence[];
  /**
   * The model's closing sentence on whether the changes match the brief: its read, never a verdict.
   * Absent when the build had no brief or the model wrote none.
   */
  match?: AiSummarySentence;
  /** The summary call's tokens (PS-233); absent on a summary older than that. */
  usage?: AiUsage;
};
