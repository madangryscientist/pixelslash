import { resolve } from "node:path";
import {
  UsageError,
  captureInto,
  findConfig,
  loadConfig,
  openCaptureSession,
  recapture,
  type SnapshotDeps,
  type UploadDeps,
} from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { UPLOAD_FLAGS, type UploadFlags, readFlagPairs, uploadDir } from "./upload.ts";

export const CAPTURE_USAGE =
  "pixelslash capture [--config FILE] [--out DIR] [--upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--flake-retries N]]";

type CaptureFlags = { out: string; upload: boolean; uploadFlags: UploadFlags };

function captureFlags(argv: string[]): CaptureFlags {
  const upload = argv.includes("--upload");
  const { out = "pixelslash-snapshots", ...uploadFlags } = readFlagPairs(
    argv.filter((a) => a !== "--upload"),
    [...UPLOAD_FLAGS, "out"],
  );
  const { config: _config, ...uploadOnly } = uploadFlags;
  if (!upload && Object.keys(uploadOnly).length > 0)
    throw new UsageError(
      "--server, --token-path, --base, --branch, --pr and --flake-retries need --upload",
    );
  return { out: resolve(out), upload, uploadFlags };
}

/**
 * `pixelslash capture`: every route × variant in the config into a snapshot dir + manifest. Exit 0.
 * With `--upload` the browser stays open through the upload, so a shot that differs from its
 * baseline is captured again the same way (ob 1737), and closes after it.
 */
export async function runCapture(
  argv: string[],
  io: Io,
  deps: SnapshotDeps & UploadDeps = {},
): Promise<number> {
  const flags = captureFlags(argv);
  const config = await loadConfig(findConfig(flags.uploadFlags.config, process.cwd()));
  const session = await openCaptureSession(config, {
    ...deps,
    warn: (m) => io.stderr.write(`${m}\n`),
  });
  try {
    const result = await captureInto(session, flags.out);
    const [first] = result.manifest.snapshots;
    io.stdout.write(`pixelslash: ${result.manifest.snapshots.length} snapshots\n`);
    if (first) io.stdout.write(`fingerprint: ${JSON.stringify(first.fingerprint)}\n`);
    io.stdout.write(`manifest: ${result.manifestPath}\n`);
    if (!flags.upload) return 0;
    // The config's retries unless the flag says otherwise; the shots were just shot here.
    const retries = flags.uploadFlags["flake-retries"] ?? String(config.flake.retries);
    return await uploadDir(flags.out, { ...flags.uploadFlags, "flake-retries": retries }, io, {
      ...deps,
      recapture: (e) => recapture(session, e),
    });
  } finally {
    await session.close();
  }
}
