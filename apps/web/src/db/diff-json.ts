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
};

/** A rectangle in image px that the diff skips; the same shape as the engine's `IgnoreRect`. */
export type IgnoreRect = { x: number; y: number; width: number; height: number };

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
};
