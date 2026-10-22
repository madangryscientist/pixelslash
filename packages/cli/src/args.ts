import { resolve } from "node:path";
import {
  UsageError,
  parseDiffOption,
  type CompareOptions,
  type DiffOptions,
  type IgnoreRect,
} from "@pixelslash/engine";

export const USAGE =
  "pixelslash (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--label TEXT] [--threshold 0..1] [--min-changed-pixels N] [--min-changed-ratio 0..1] [--merge-distance PX] [--min-region-area PX] [--noise-amplitude 0..1] [--max-shift 0..1] [--ignore x,y,w,h]...\nURL origins may omit --ds and --file, including --routes. PNG route dirs still need --ds or --file.";
const DEFAULT_WIDTH = 1280;

export type Cli = CompareOptions & {
  routesFile: string | undefined;
  file: string | undefined;
  tokenPath: string | undefined;
};

/** `--flag value` pairs, in order; which flags are allowed is the caller's call. */
export function readFlags(argv: string[]): Map<string, string> {
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

/** `--ignore x,y,w,h` may repeat, which a flag map cannot hold: pull the pairs out first. */
function takeIgnore(argv: string[]): { rects: IgnoreRect[]; rest: string[] } {
  const rects: IgnoreRect[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== "--ignore") {
      rest.push(argv[i] ?? "");
      if (i + 1 < argv.length) rest.push(argv[i + 1] ?? "");
      continue;
    }
    rects.push(parseIgnore(argv[i + 1]));
  }
  return { rects, rest };
}

const WHOLE = /^\d+$/;
/** The smallest legal value for x, y, width, height. */
const FLOOR = [0, 0, 1, 1];

const inRange = (value: number, i: number) =>
  Number.isSafeInteger(value) && value >= (FLOOR[i] ?? 0);

/** `x,y,w,h` as whole numbers, or null when any part is missing or out of range. */
function parseRect(parts: string[]): IgnoreRect | null {
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (WHOLE.test(p) ? Number(p) : Number.NaN));
  if (!nums.every(inRange)) return null;
  const [x = Number.NaN, y = Number.NaN, width = Number.NaN, height = Number.NaN] = nums;
  return { x, y, width, height };
}

/** `x,y,w,h` in image px: x and y are 0 or more, width and height at least 1. */
function parseIgnore(raw: string | undefined): IgnoreRect {
  if (!raw || raw.startsWith("--")) throw new UsageError("missing value for --ignore");
  const rect = parseRect(raw.split(",").map((p) => p.trim()));
  if (rect) return rect;
  throw new UsageError(
    `--ignore must be x,y,w,h in pixels: whole numbers, width and height at least 1 (got "${raw}")`,
  );
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

const DIFF_FLAGS = {
  threshold: "threshold",
  "min-changed-pixels": "minChangedPixels",
  "min-changed-ratio": "minChangedRatio",
  "merge-distance": "mergeDistance",
  "min-region-area": "minRegionArea",
  "noise-amplitude": "noiseAmplitude",
  "max-shift": "maxShift",
} as const;

/** `--threshold` and friends, validated like the config's `diff` keys; unset flags are left out. */
function parseDiff(flags: Map<string, string>): DiffOptions {
  const diff: DiffOptions = {};
  for (const [flag, key] of Object.entries(DIFF_FLAGS)) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    diff[key] = parseDiffOption(key, Number(raw), `--${flag}`, (where, what) => {
      throw new UsageError(`${where} ${what}`);
    });
  }
  return diff;
}

function resolved(flags: Map<string, string>, key: string): string | undefined {
  const raw = flags.get(key);
  return raw ? resolve(raw) : undefined;
}

export function parseArgs(argv: string[]): Cli {
  const { rects: ignore, rest } = takeIgnore(argv);
  const flags = readFlags(rest);
  const mode = inputMode(flags);
  if (ignore.length > 0 && (mode === "png-dir" || flags.has("routes")))
    throw new UsageError("--ignore applies to a single pair, not --routes");
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
    diff: parseDiff(flags),
    ignore,
  };
}

/** `--json` is a switch, not a `--flag value` pair: take it out before the pairs are read. */
export function takeJson(argv: string[]): { json: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== "--json");
  return { json: rest.length !== argv.length, rest };
}
