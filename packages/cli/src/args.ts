import { resolve } from "node:path";
import { UsageError, type CompareOptions } from "@pixelslash/engine";

export const USAGE =
  "pixelslash (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--label TEXT]\nURL origins may omit --ds and --file, including --routes. PNG route dirs still need --ds or --file.";
const DEFAULT_WIDTH = 1280;

export type Cli = CompareOptions & {
  routesFile: string | undefined;
  file: string | undefined;
  tokenPath: string | undefined;
};

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith("--")) throw new UsageError(`missing value for --${key}`);
    flags.set(key, val);
  }
  return flags;
}

function count(flags: Map<string, string>, a: string, b: string): number {
  return Number(flags.has(a)) + Number(flags.has(b));
}

type Mode = "url" | "png" | "png-dir";

function inputMode(flags: Map<string, string>): Mode {
  const urls = count(flags, "live", "local");
  const pngs = count(flags, "live-png", "local-png");
  const pngDirs = count(flags, "live-png-dir", "local-png-dir");
  const routes = flags.has("routes");
  if (pngDirs > 0 && !routes)
    throw new UsageError("--live-png-dir / --local-png-dir need --routes FILE");
  // How many of each input pair were given: exactly one pair, both halves.
  const shape = `${urls}${pngs}${pngDirs}`;
  if (shape === "200") return "url";
  if (shape === "020" && !routes) return "png";
  if (shape === "002" && routes) return "png-dir";
  throw new UsageError(
    "need --live URL --local URL or --live-png PATH --local-png PATH or --live-png-dir DIR --local-png-dir DIR --routes FILE",
  );
}

function parseWidth(raw: string | undefined): number {
  const width = raw === undefined ? DEFAULT_WIDTH : Number(raw);
  if (!Number.isInteger(width) || width <= 0)
    throw new UsageError("--width must be a positive integer");
  return width;
}

function resolved(flags: Map<string, string>, key: string): string | undefined {
  const raw = flags.get(key);
  return raw ? resolve(raw) : undefined;
}

export function parseArgs(argv: string[]): Cli {
  const flags = readFlags(argv);
  const mode = inputMode(flags);
  const hasDs = flags.has("ds");
  const hasFile = flags.has("file");
  if (hasDs && hasFile) throw new UsageError("need --ds DIR or --file FILE_KEY, not both");
  if (!hasDs && !hasFile && mode === "png-dir")
    throw new UsageError("need --ds DIR or --file FILE_KEY");
  const width = parseWidth(flags.get("width"));
  return {
    live: flags.get("live"),
    local: flags.get("local"),
    livePng: resolved(flags, "live-png"),
    localPng: resolved(flags, "local-png"),
    livePngDir: resolved(flags, "live-png-dir"),
    localPngDir: resolved(flags, "local-png-dir"),
    routes: undefined,
    routesFile: resolved(flags, "routes"),
    ds: resolved(flags, "ds"),
    file: flags.get("file"),
    tokenPath: resolved(flags, "token-path"),
    out: resolve(flags.get("out") ?? ".pixelslash"),
    width,
    label: flags.get("label"),
  };
}
