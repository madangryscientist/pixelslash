export {
  compare,
  compareRoutes,
  type CompareOptions,
  type CompareResult,
  type Deps,
} from "./compare.ts";
export type { CapturePage } from "./capture.ts";
export { CaptureError, FigmaError, UsageError } from "./errors.ts";
export { fetchFigmaRasters, resolveToken } from "./figma.ts";
export type { ProcLike, SpawnProc } from "./judge.ts";
export { loadRoutes } from "./routes.ts";
export type { RunManifest } from "./run.ts";
export { findConfig, loadConfig, type CaptureConfig } from "./config.ts";
export type { Fingerprint } from "./fingerprint.ts";
export {
  captureSnapshots,
  type SnapshotDeps,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./snapshot.ts";
