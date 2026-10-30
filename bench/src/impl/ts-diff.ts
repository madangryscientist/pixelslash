#!/usr/bin/env bun
/**
 * The engine behind the diff contract (ob 1909): the baseline, and the reference implementation of
 * the contract in `bench/README.md`.
 *
 *   bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json
 *     [--engine wasm] [--decode parallel|sequential] [--no-tiles]
 *
 * It runs the engine's one diff, `wasmDiff` (PS-210: `diff.wasm`, the same module the CLI and the
 * server run), so the verdict and regions are the engine's. The decode is inside that call, with
 * the pixel loop; the call reports its phases (PS-212), so `decode_ms` is reading the two files
 * plus the call's `decode_*` phases, and `diff_ms` is the rest of the call. The overlay
 * is not encoded: the contract does not ask for it, and the engine's encode is swapped for a no-op
 * (what `--overlay none` did before the JS encoders were retired, PS-211).
 *
 * `--engine` takes `wasm` only (PS-209's spelling, kept so a recorded command still runs). The
 * pngjs and napi-image engines went in PS-210 and PS-211: this is the only one left in JS. There is
 * no decoder to choose, so `--decoder` and `--overlay` are usage errors, and the runner's `--decode`
 * is accepted and ignored. `--no-tiles` turns off the engine's tile pass (PS-191: hash 64 px
 * tiles, compare only the ones that differ; on by default), so a tiles-off/tiles-on A/B is two
 * `--impl`s in one run.
 * Exit 2 on bad usage, 1 when a file cannot be read or decoded.
 */
// The diff entry, not the package root: the root also exports capture, which loads Playwright.
import { readFileSync } from "node:fs";
import { wasmDiff } from "@hackcove/pixelslash-engine/diff-wasm";
import { SPAWN_AT_ENV, type ImplOutput } from "./contract.ts";
import { changeRegions } from "../pixelslash.ts";
import { say, warn } from "../say.ts";

const USAGE =
  "usage: ts-diff.ts [--engine wasm] [--decode parallel|sequential] [--no-tiles] diff <base.png> <head.png> --json";

type Args = { basePath: string; headPath: string; tiles: boolean };

const SWITCHES = ["--decode", "--engine"];
/** Switches that take no value. */
const FLAGS = ["--no-tiles"];

/** The switches and the operands apart; null when a switch has no value or comes twice. */
function splitSwitches(argv: string[]): { seen: Map<string, string>; operands: string[] } | null {
  const seen = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i] ?? "";
    if (FLAGS.includes(name)) {
      if (seen.has(name)) return null;
      seen.set(name, "");
      continue;
    }
    if (!SWITCHES.includes(name)) {
      operands.push(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || seen.has(name)) return null;
    seen.set(name, value);
  }
  return { seen, operands };
}

/** `diff <base> <head> --json` and nothing more: the two paths, or null. */
function diffOperands(operands: string[]): [string, string] | null {
  const [verb, basePath, headPath, flag, ...extra] = operands;
  if (verb !== "diff" || !basePath || !headPath || flag !== "--json" || extra.length > 0)
    return null;
  return [basePath, headPath];
}

/**
 * `diff <base> <head> --json`, with each switch at most once, before `diff` (the impl's own flags,
 * as `--impl` gives them) or after its operands (the runner's `--decode`).
 */
export function parseArgs(argv: string[]): Args | null {
  const split = splitSwitches(argv);
  const paths = split && diffOperands(split.operands);
  if (!split || !paths) return null;
  const [basePath, headPath] = paths;
  return switchesKnown(split.seen)
    ? { basePath, headPath, tiles: !split.seen.has("--no-tiles") }
    : null;
}

/** A switch's value, defaulted; null when it is not one `isKnown` accepts. */
function pick<T extends string>(
  seen: Map<string, string>,
  name: string,
  fallback: T,
  isKnown: (value: string) => value is T,
): T | null {
  const value = seen.get(name) ?? fallback;
  return isKnown(value) ? value : null;
}

const isEngine = (value: string): value is "wasm" => value === "wasm";
const isMode = (value: string): value is "parallel" | "sequential" =>
  value === "parallel" || value === "sequential";

/** Each switch's value is a known name, defaulted when absent. */
function switchesKnown(seen: Map<string, string>): boolean {
  return (
    pick(seen, "--engine", "wasm", isEngine) !== null &&
    pick(seen, "--decode", "sequential", isMode) !== null
  );
}

/** The engine's diff (`wasmDiff`): decode, unfilter and compare in one call. */
function diffPair(args: Args): ImplOutput {
  const reading = performance.now();
  const baseBytes = readFileSync(args.basePath);
  const headBytes = readFileSync(args.headPath);
  const decodeMs = performance.now() - reading;
  const phases: Record<string, number> = {};
  const diffing = performance.now();
  // No overlay PNG: the contract does not ask for one, and its encode is not timed.
  const result = wasmDiff([baseBytes, headBytes], {
    encode: () => Buffer.alloc(0),
    phases,
    tiles: args.tiles,
  });
  const callMs = performance.now() - diffing;
  const decoding = Object.entries(phases)
    .filter(([name]) => name.startsWith("decode_"))
    .reduce((sum, [, ms]) => sum + ms, 0);
  return {
    verdict: result.changed ? "changed" : "unchanged",
    regions: changeRegions(result),
    decode_ms: decodeMs + decoding,
    diff_ms: Math.max(0, callMs - decoding),
    phases: { decode_read: decodeMs, ...phases },
  };
}

async function main(argv: string[]): Promise<number> {
  const startedAt = performance.timeOrigin + performance.now();
  const args = parseArgs(argv);
  if (!args) {
    warn(USAGE);
    return 2;
  }
  const spawnedAt = Number(process.env[SPAWN_AT_ENV]);
  try {
    const out = diffPair(args);
    // Unset or not a number (run by hand): there is no spawn to measure from.
    if (process.env[SPAWN_AT_ENV] !== undefined && Number.isFinite(spawnedAt))
      out.startup_ms = Math.max(0, startedAt - spawnedAt);
    const rss = peakRssBytes();
    if (rss !== null) out.peak_rss_bytes = rss;
    say(JSON.stringify(out));
    return 0;
  } catch (e) {
    warn(`ts-diff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** This process's peak resident set, from `VmHWM` (Linux only; null elsewhere). Not `resourceUsage().maxRSS`:
 * Linux carries the parent's high-water mark through fork and exec into it. */
function peakRssBytes(): number | null {
  try {
    const kb = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
    return kb === undefined ? null : Number(kb) * 1024;
  } catch {
    return null;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
