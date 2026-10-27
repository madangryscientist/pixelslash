export {
  compare,
  compareRoutes,
  type CompareOptions,
  type CompareResult,
  type Deps,
} from "./compare.ts";
export { changeLines } from "./compare-report.ts";
export {
  compareSnapshots,
  notComparedLines,
  notComparedSummary,
  type SnapshotCompareDeps,
  type SnapshotCompareOptions,
  type SnapshotCompareResult,
} from "./compare-snapshots.ts";
export {
  CAPTURE_BROWSER,
  keepNativeRaf,
  playwrightCli,
  settleCapture,
  type CapturePage,
} from "./capture.ts";
export { CaptureError, FigmaError, UploadError, UsageError } from "./errors.ts";
export { fetchFigmaRasters, resolveToken } from "./figma.ts";
export {
  askOpencode,
  JudgeError,
  OPENCODE_MODEL_ENV,
  type ProcLike,
  type SpawnProc,
} from "./judge.ts";
export { importPngs, type ImportOptions, type ImportResult } from "./import-pngs.ts";
export { isHttpUrl, loadRoutes } from "./routes.ts";
export type { RunManifest } from "./run.ts";
export type { CaptureSetup, SetupArgs } from "./setup.ts";
export {
  CONFIG_NAMES,
  DEFAULT_FLAKE_RETRIES,
  findConfig,
  findConfigIfAny,
  loadConfig,
  parseConfig,
  resolveDiff,
  type CaptureConfig,
  type CompositionConfig,
  type FlakyPolicy,
  type Route,
  type Variant,
} from "./config.ts";
export { maskLocators, measureIgnore } from "./page-areas.ts";
export {
  CUSTOM_ATTRIBUTE,
  parseCompositionEntry,
  type Composition,
  type Gap,
  type GapKind,
  type SpecialCase,
} from "./composition.ts";
export { gapsList, type GapGroup, type GapsList } from "./composition-report.ts";
export { parseDiffOption } from "./diff-options.ts";
export type { Fingerprint } from "./fingerprint.ts";
export { fontSetHash, imageId } from "./fingerprint.ts";
export { identity, pngPath, readManifest } from "./manifest.ts";
export {
  MASK_COLOR,
  captureInto,
  captureSnapshots,
  openCaptureSession,
  recapture,
  toImageRects,
  type CaptureSession,
  type MediaBox,
  type Shoot,
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
  type SettledBy,
} from "./diff.ts";
export type { Raster } from "./diff-probe.ts";
export {
  baselinesInto,
  checkAgainstServer,
  onlyRoutes,
  type BaselineSource,
  type CheckDeps,
  type CheckOptions,
  type CheckResult,
  type CheckShot,
} from "./check.ts";
export {
  uploadSnapshots,
  type UploadDeps,
  newUploadProgress,
  type UploadProgress,
  type UploadResult,
} from "./upload.ts";
export type { FlakyShot, SkippedShot } from "./flake-upload.ts";
export type { FlakeRecord } from "./flake.ts";
export {
  CAUSE_WORDS,
  measureRepro,
  mediaOfShots,
  renderReproReport,
  suggestFixes,
  type ConfigEdit,
  type Repro,
  type Suggestion,
} from "./flake-repro.ts";
export type { Region, RegionKind, Specks } from "./regions.ts";
export { buildTimings, timingLine, type Timings } from "./timings.ts";
export { CLIENT_VERSION, USER_AGENT } from "./version.ts";
export {
  DEFAULT_MAX_BYTES,
  devStore,
  latestIteration,
  pinIteration,
  readPins,
  unpinIteration,
  type DevDifferences,
  type DevIteration,
  type DevJudge,
  type DevStore,
} from "./dev-store.ts";
export {
  devConfig,
  loadDevConfig,
  narrowSession,
  probeTarget,
  targetName,
  targetUrl,
} from "./dev-target.ts";
export { runIteration, type FetchMain } from "./dev-run.ts";
export { judgeIteration, type DevJudgeDeps } from "./dev-judge.ts";
export { explainIteration } from "./dev-explain.ts";
export { type ChangeNoter, changeNoter } from "./change-note.ts";
export {
  inlinePng,
  loadFeature,
  type DevFeature,
  type DevRef,
  type FeatureSource,
} from "./dev-refs.ts";
export { DEFAULT_QUIET_MS, debounce, notIgnored, watchTree, type Debouncer } from "./dev-watch.ts";
export {
  claimSession,
  ensureIgnored,
  liveSession,
  worktreeRoot,
  type DevLock,
} from "./dev-lock.ts";
export { DEV_HEADER, serveDevPage, type DevState } from "./dev-page.ts";
export { devController, type DevController } from "./dev-session.ts";
