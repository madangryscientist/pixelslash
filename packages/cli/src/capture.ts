import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  buildTimings,
  captureInto,
  findConfig,
  loadConfig,
  onlyRoutes,
  openCaptureSession,
  recapture,
  timingLine,
  type SnapshotDeps,
  type Timings,
  type UploadDeps,
  type DevJudgeDeps,
} from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { readFlagPairs, takeJson, takeOnly } from "./args.ts";
import { UPLOAD_FLAGS, type UploadFlags, uploadDir } from "./upload.ts";
import { type Watch, watched } from "./watch.ts";

type SnapshotResult = Awaited<ReturnType<typeof captureInto>>;

/** A capture and how long it took, browser launch included. */
type TimedSnapshotResult = SnapshotResult & { timings: Timings };

export const CAPTURE_USAGE =
  "pixelslash capture [--config FILE] [--out DIR] [--only NAME]... [--json] | [--upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--flake-retries N] [--judge]]";

type CaptureFlags = {
  out: string;
  upload: boolean;
  uploadFlags: UploadFlags;
  only: string[] | undefined;
  json: boolean;
};

const SWITCHES = new Set(["--upload", "--judge"]);

function captureFlags(argv: string[], cwd: string): CaptureFlags {
  const { json, rest: pairs } = takeJson(argv);
  const { only, rest } = takeOnly(pairs);
  const upload = rest.includes("--upload");
  const judge = rest.includes("--judge");
  const { out = "pixelslash-snapshots", ...uploadFlags } = readFlagPairs(
    rest.filter((a) => !SWITCHES.has(a)),
    [...UPLOAD_FLAGS, "out"],
  );
  const { config: _config, ...uploadOnly } = uploadFlags;
  if (!upload && (judge || Object.keys(uploadOnly).length > 0))
    throw new UsageError(
      "--server, --token-path, --base, --branch, --pr, --flake-retries and --judge need --upload",
    );
  // A partial build would tell the server the other routes were removed.
  if (upload && (only || json)) throw new UsageError("--only and --json do not go with --upload");
  return { out: resolve(cwd, out), upload, uploadFlags: { ...uploadFlags, judge }, only, json };
}

/** `--json` and `capture_local`: every shot taken, with its PNG's absolute path. */
export function captureJson(
  out: string,
  { manifest, manifestPath, timings, gapsPath }: TimedSnapshotResult,
) {
  return {
    measured: "local",
    uploaded: false,
    manifest: manifestPath,
    ...(gapsPath && { gaps: gapsPath }),
    timings,
    shots: manifest.snapshots.map((e) => ({
      name: e.name,
      variant: e.variant.name,
      browser: e.variant.browser,
      viewport: `${e.variant.viewport.width}x${e.variant.viewport.height}`,
      theme: e.variant.theme,
      file: join(out, e.file),
      ...(e.composition && { composition: e.composition }),
    })),
  };
}

/** The routes `only` names (all when absent) into `out`, nothing uploaded; `capture_local`'s run. */
export async function captureLocal(
  flags: { config?: string | undefined; out: string; only: string[] | undefined },
  deps: SnapshotDeps & { cwd?: string },
  watch: Watch = {},
): Promise<TimedSnapshotResult> {
  const started = performance.now();
  const config = await loadConfig(findConfig(flags.config, deps.cwd ?? process.cwd()));
  const session = await openCaptureSession(config, deps);
  try {
    const shooting = onlyRoutes(session, flags.only);
    const total = shooting.routes.length * config.variants.length;
    const result = await captureInto(watched(shooting, watch, total), flags.out);
    return {
      ...result,
      timings: buildTimings(started, result.shots, session.browserLaunchMs),
    };
  } finally {
    await session.close();
  }
}

function printCaptured(result: SnapshotResult, io: Io): void {
  const [first] = result.manifest.snapshots;
  io.stdout.write(`pixelslash: ${result.manifest.snapshots.length} snapshots\n`);
  if (first) io.stdout.write(`fingerprint: ${JSON.stringify(first.fingerprint)}\n`);
  io.stdout.write(`manifest: ${result.manifestPath}\n`);
  if (result.gapsPath) io.stdout.write(`${gapsLine(result)}\n`);
}

/** A composition-only capture's gap list (ob 1850): the counts and the page. Not a verdict; the exit stays 0. */
function gapsLine({ manifest, gapsPath = "" }: SnapshotResult): string {
  const found = manifest.snapshots.flatMap((e) => (e.composition ? [e.composition] : []));
  const gaps = found.reduce((n, c) => n + c.gaps.length, 0);
  const special = found.reduce((n, c) => n + c.special.length, 0);
  return `gaps: ${gaps} styled outside the library, ${special} special ${special === 1 ? "case" : "cases"}: ${pathToFileURL(gapsPath).href}`;
}

/**
 * `pixelslash capture`: every route × variant in the config into a snapshot dir + manifest. Exit 0.
 * With `--upload` the browser stays open through the upload, so a shot that differs from its
 * baseline is captured again the same way (ob 1737), and closes after it.
 */
export async function runCapture(
  argv: string[],
  io: Io,
  deps: SnapshotDeps & UploadDeps & DevJudgeDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const flags = captureFlags(argv, cwd);
  const warn = (m: string) => io.stderr.write(`${m}\n`);
  if (!flags.upload) {
    const config = flags.uploadFlags.config;
    const result = await captureLocal(
      { config, out: flags.out, only: flags.only },
      {
        ...deps,
        cwd,
        warn,
      },
    );
    if (flags.json) io.stdout.write(`${JSON.stringify(captureJson(flags.out, result), null, 2)}\n`);
    else printCaptured(result, io);
    io.stderr.write(`${timingLine(result.timings)}\n`);
    return 0;
  }
  const started = performance.now();
  const config = await loadConfig(findConfig(flags.uploadFlags.config, cwd));
  const session = await openCaptureSession(config, {
    ...deps,
    warn,
  });
  try {
    const result = await captureInto(session, flags.out);
    const timings = buildTimings(started, result.shots, session.browserLaunchMs);
    printCaptured(result, io);
    // The config's retries unless the flag says otherwise; the shots were just shot here.
    const retries = flags.uploadFlags["flake-retries"] ?? String(config.flake.retries);
    return await uploadDir(flags.out, { ...flags.uploadFlags, "flake-retries": retries }, io, {
      ...deps,
      recapture: (e) => recapture(session, e),
      timings,
    });
  } finally {
    await session.close();
  }
}
