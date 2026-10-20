import { resolve } from "node:path";
import {
  UsageError,
  captureSnapshots,
  findConfig,
  loadConfig,
  type SnapshotDeps,
  type UploadDeps,
} from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { UPLOAD_FLAGS, type UploadFlags, readFlagPairs, uploadDir } from "./upload.ts";

export const CAPTURE_USAGE =
  "pixelslash capture [--config FILE] [--out DIR] [--upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N]]";

type CaptureFlags = { out: string; upload: boolean; uploadFlags: UploadFlags };

function captureFlags(argv: string[]): CaptureFlags {
  const upload = argv.includes("--upload");
  const { out = "pixelslash-snapshots", ...uploadFlags } = readFlagPairs(
    argv.filter((a) => a !== "--upload"),
    [...UPLOAD_FLAGS, "out"],
  );
  const { config: _config, ...uploadOnly } = uploadFlags;
  if (!upload && Object.keys(uploadOnly).length > 0)
    throw new UsageError("--server, --token-path, --base, --branch and --pr need --upload");
  return { out: resolve(out), upload, uploadFlags };
}

/** `pixelslash capture`: every route × variant in the config into a snapshot dir + manifest. Exit 0. */
export async function runCapture(
  argv: string[],
  io: Io,
  deps: SnapshotDeps & UploadDeps = {},
): Promise<number> {
  const flags = captureFlags(argv);
  const config = await loadConfig(findConfig(flags.uploadFlags.config, process.cwd()));
  const result = await captureSnapshots(config, flags.out, {
    ...deps,
    warn: (m) => io.stderr.write(`${m}\n`),
  });
  const [first] = result.manifest.snapshots;
  io.stdout.write(`pixelslash: ${result.manifest.snapshots.length} snapshots\n`);
  if (first) io.stdout.write(`fingerprint: ${JSON.stringify(first.fingerprint)}\n`);
  io.stdout.write(`manifest: ${result.manifestPath}\n`);
  return flags.upload ? uploadDir(flags.out, flags.uploadFlags, io, deps) : 0;
}
