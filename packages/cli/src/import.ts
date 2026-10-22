import { resolve } from "node:path";
import { UsageError, importPngs } from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { readFlagPairs } from "./upload.ts";

export const IMPORT_USAGE =
  "pixelslash import PNG_DIR [--out DIR] [--viewport WxH] [--theme light|dark] [--renderer LABEL]\nPNG_DIR holds PNGs from any screenshot tool; the result is a snapshot dir for `pixelslash upload`.";

const DEFAULT_VIEWPORT = "1280x720";
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

/** `pixelslash import PNG_DIR`: a dir of PNGs into a snapshot dir + manifest. Exit 0; 2 on a bad flag or dir. */
export async function runImport(argv: string[], io: Io): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir || dir.startsWith("--")) throw new UsageError("need a PNG_DIR");
  const flags = readFlagPairs(rest, ["out", "viewport", "theme", "renderer"]);
  const { manifest, manifestPath } = await importPngs({
    dir: resolve(dir),
    out: resolve(flags.out ?? "pixelslash-snapshots"),
    viewport: parseViewport(flags.viewport ?? DEFAULT_VIEWPORT),
    theme: parseTheme(flags.theme ?? "light"),
    renderer: flags.renderer ?? "external",
  });
  io.stdout.write(`pixelslash: ${manifest.snapshots.length} snapshots\n`);
  io.stdout.write(`manifest: ${manifestPath}\n`);
  return 0;
}
