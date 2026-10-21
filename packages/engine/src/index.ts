export {
  compare,
  compareRoutes,
  type CompareOptions,
  type CompareResult,
  type Deps,
} from "./compare.ts";
export {
  compareSnapshots,
  type SnapshotCompareDeps,
  type SnapshotCompareOptions,
  type SnapshotCompareResult,
} from "./compare-snapshots.ts";
export type { CapturePage } from "./capture.ts";
export { CaptureError, FigmaError, UploadError, UsageError } from "./errors.ts";
export { fetchFigmaRasters, resolveToken } from "./figma.ts";
export type { ProcLike, SpawnProc } from "./judge.ts";
export { loadRoutes } from "./routes.ts";
export type { RunManifest } from "./run.ts";
export { findConfig, findConfigIfAny, loadConfig, type CaptureConfig } from "./config.ts";
export { parseDiffOption } from "./diff-options.ts";
export type { Fingerprint } from "./fingerprint.ts";
export {
  captureSnapshots,
  type SnapshotDeps,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./snapshot.ts";
export {
  DEFAULT_THRESHOLD,
  diffPngs,
  type DiffIgnore,
  type DiffOptions,
  type IgnoreRect,
  type PixelDiff,
} from "./diff.ts";
export { uploadSnapshots, type UploadDeps } from "./upload.ts";
export type { Region, RegionKind, Specks } from "./regions.ts";
