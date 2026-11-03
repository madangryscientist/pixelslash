import { resolve } from "node:path";
import {
  PLATFORMS,
  UsageError,
  importPngs,
  type NativePlatform,
} from "@hackcove/pixelslash-engine";
import type { Io } from "./run.ts";
import { readFlagPairs } from "./args.ts";

export const IMPORT_USAGE =
  "pixelslash import PNG_DIR [--out DIR] [--viewport WxH] [--theme light|dark] [--renderer LABEL]\n" +
  '  [--platform web|android|ios --device "<label>" --scale N]\n' +
  "PNG_DIR holds PNGs from any screenshot tool; the result is a snapshot dir for `pixelslash upload`.\n" +
  "A <name>.metrics.json beside <name>.png is layout metrics (docs/metrics.md) and travels with it.\n" +
  "android and ios (Maestro) need --device and --scale; --viewport is then optional (the PNG size / scale).";

const VIEWPORT = /^([1-9]\d*)x([1-9]\d*)$/;

function parseViewport(raw: string): { width: number; height: number } {
  const m = VIEWPORT.exec(raw);
  if (!m) throw new UsageError(`--viewport must be WxH in whole pixels (got "${raw}")`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseTheme(raw: string): "light" | "dark" {
  if (raw === "light" || raw === "dark") return raw;
  throw new UsageError(`--theme must be light or dark (got "${raw}")`);
}

/** `web` (the default) or a native platform; anything else is exit 2. */
function parsePlatform(raw: string | undefined): NativePlatform | undefined {
  if (raw === undefined || raw === "web") return undefined;
  if (raw === "android" || raw === "ios") return raw;
  throw new UsageError(`--platform must be one of ${PLATFORMS.join(", ")} (got "${raw}")`);
}

function parseScale(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0)
    throw new UsageError(`--scale must be a number above 0 (got "${raw}")`);
  return n;
}

type NativeFlags = {
  viewport?: { width: number; height: number };
  platform?: NativePlatform;
  device?: string;
  scale?: number;
};

/** The viewport and the native flags as values; `importPngs` owns the rules between them (exit 2). */
function parseNative(flags: Record<string, string | undefined>): NativeFlags {
  const platform = parsePlatform(flags.platform);
  const scale = parseScale(flags.scale);
  const { device, viewport } = flags;
  return {
    ...(viewport !== undefined && { viewport: parseViewport(viewport) }),
    ...(platform && { platform }),
    ...(device !== undefined && { device }),
    ...(scale !== undefined && { scale }),
  };
}

/** `pixelslash import PNG_DIR`: a dir of PNGs into a snapshot dir + manifest. Exit 0; 2 on a bad flag or dir. */
export async function runImport(argv: string[], io: Io): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir || dir.startsWith("--")) throw new UsageError("need a PNG_DIR");
  const flags = readFlagPairs(rest, [
    "out",
    "viewport",
    "theme",
    "renderer",
    "platform",
    "device",
    "scale",
  ]);
  const native = parseNative(flags);
  const { manifest, manifestPath, notes } = await importPngs({
    dir: resolve(dir),
    out: resolve(flags.out ?? "pixelslash-snapshots"),
    theme: parseTheme(flags.theme ?? "light"),
    renderer: flags.renderer ?? "external",
    ...native,
  });
  for (const note of notes) io.stderr.write(`note: ${note}\n`);
  io.stdout.write(`pixelslash: ${manifest.snapshots.length} snapshots\n`);
  const withMetrics = manifest.snapshots.filter((e) => e.metrics).length;
  if (withMetrics > 0) io.stdout.write(`metrics: ${withMetrics}\n`);
  io.stdout.write(`manifest: ${manifestPath}\n`);
  return 0;
}
