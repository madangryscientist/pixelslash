import { resolve } from "node:path";
import {
  UsageError,
  captureSnapshots,
  findConfig,
  loadConfig,
  type SnapshotDeps,
} from "@pixelslash/engine";
import type { Io } from "./run.ts";

export const CAPTURE_USAGE = "pixelslash capture [--config FILE] [--out DIR]";

function captureFlags(argv: string[]): { config: string | undefined; out: string } {
  let config: string | undefined;
  let out = "pixelslash-snapshots";
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const val = argv[i + 1];
    if (flag !== "--config" && flag !== "--out")
      throw new UsageError(`unexpected argument: ${flag}`);
    if (!val || val.startsWith("--")) throw new UsageError(`missing value for ${flag}`);
    if (flag === "--config") config = val;
    else out = val;
  }
  return { config, out: resolve(out) };
}

/** `pixelslash capture`: every route × variant in the config into a snapshot dir + manifest. Exit 0. */
export async function runCapture(argv: string[], io: Io, deps: SnapshotDeps = {}): Promise<number> {
  const flags = captureFlags(argv);
  const config = await loadConfig(findConfig(flags.config, process.cwd()));
  const result = await captureSnapshots(config, flags.out, {
    ...deps,
    warn: (m) => io.stderr.write(`${m}\n`),
  });
  const [first] = result.manifest.snapshots;
  io.stdout.write(`pixelslash: ${result.manifest.snapshots.length} snapshots\n`);
  if (first) io.stdout.write(`fingerprint: ${JSON.stringify(first.fingerprint)}\n`);
  io.stdout.write(`manifest: ${result.manifestPath}\n`);
  return 0;
}
