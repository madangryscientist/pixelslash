#!/usr/bin/env bun
/**
 * The TypeScript engine behind the diff contract (ob 1909): the baseline, and the reference
 * implementation of the contract in `bench/README.md`.
 *
 *   bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json
 *     [--decode parallel|sequential] [--decoder <name>] [--overlay <name>]
 *
 * It decodes the two files itself with `--decoder`: by default napi-image, the fastest permissive
 * one measured (PS-168); pngjs, the engine's own, is split into phases in `ts-decode.ts`. It hands
 * the pixels to the engine's `diffRasters`, the call `diffPngs` makes after its own decode, so the
 * verdict and regions are the engine's. `decode_ms` is reading and decoding both files, `diff_ms`
 * is the `diffRasters` call (pixel diff and region clustering) plus encoding the overlay with
 * `--overlay`. The contract does not ask for the overlay, so the default is `none`, which encodes
 * nothing (PS-168); `--overlay pngjs` is what the engine itself does. `phases` splits both. The
 * names are in `ts-codecs.ts`. Exit 2 on bad usage, 1 when a file cannot be read or decoded.
 */
// The diff entry, not the package root: the root also exports capture, which loads Playwright.
import { readFileSync } from "node:fs";
import { diffRasters } from "@pixelslash/engine/diff";
import type { DiffPhase } from "@pixelslash/engine";
import { SPAWN_AT_ENV, type ImplOutput } from "./contract.ts";
import { changeRegions } from "../pixelslash.ts";
import { say, warn } from "../say.ts";
import {
  encodeWith,
  isDecoder,
  isOverlay,
  type DecoderName,
  type OverlayName,
} from "./ts-codecs.ts";
import { addTimes, decodeFile, type Decoded } from "./ts-decode.ts";
import type { WorkerReply, WorkerRequest } from "./ts-decode-worker.ts";

const USAGE =
  "usage: ts-diff.ts [--decoder <name>] [--overlay <name>] [--decode parallel|sequential] diff <base.png> <head.png> --json";

export const DEFAULT_DECODER: DecoderName = "napi-image";
export const DEFAULT_OVERLAY: OverlayName = "none";

type Args = {
  basePath: string;
  headPath: string;
  parallel: boolean;
  decoder: DecoderName;
  overlay: OverlayName;
};

const SWITCHES = ["--decode", "--decoder", "--overlay"];

/** The switches and the operands apart; null when a switch has no value or comes twice. */
function splitSwitches(argv: string[]): { seen: Map<string, string>; operands: string[] } | null {
  const seen = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i] ?? "";
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
  const values = switchValues(split.seen);
  return values && { basePath, headPath, ...values };
}

/** The switches' values, defaulted; null when one is not a known name. */
function switchValues(seen: Map<string, string>): Omit<Args, "basePath" | "headPath"> | null {
  const mode = seen.get("--decode") ?? "sequential";
  const decoder = seen.get("--decoder") ?? DEFAULT_DECODER;
  const overlay = seen.get("--overlay") ?? DEFAULT_OVERLAY;
  if (mode !== "parallel" && mode !== "sequential") return null;
  if (!isDecoder(decoder) || !isOverlay(overlay)) return null;
  return { parallel: mode === "parallel", decoder, overlay };
}

/** Head on a worker thread, base on this one; the worker's start-up is part of the wall time. */
async function decodeBoth(
  basePath: string,
  headPath: string,
  decoder: DecoderName,
): Promise<[Decoded, Decoded]> {
  const worker = new Worker(new URL("./ts-decode-worker.ts", import.meta.url));
  try {
    const head = new Promise<Decoded>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
        if (event.data.ok) resolve(event.data.decoded);
        else reject(new Error(event.data.message));
      });
      worker.addEventListener("error", (event) => reject(new Error(event.message)));
    });
    const request: WorkerRequest = { path: headPath, decoder };
    worker.postMessage(request, { transfer: [] });
    const base = await decodeFile(basePath, decoder);
    return [base, await head];
  } finally {
    worker.terminate();
  }
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
    const decoding = performance.now();
    const [base, head] = args.parallel
      ? await decodeBoth(args.basePath, args.headPath, args.decoder)
      : [
          await decodeFile(args.basePath, args.decoder),
          await decodeFile(args.headPath, args.decoder),
        ];
    const decodeMs = performance.now() - decoding;
    const times = addTimes(base.times, head.times);
    const phases: Record<string, number> = {
      decode_read: times.read,
      decode_inflate: times.inflate,
      decode_unfilter: times.unfilter,
      decode_other: times.other,
    };
    const probe = (phase: DiffPhase, ms: number) => {
      phases[phase] = ms;
    };
    const diffing = performance.now();
    // The engine's own encode is swapped for a capture, so `--overlay` alone decides what is encoded.
    let overlay: Uint8Array | null = null;
    const capture = ({ data }: { data: Uint8Array }) => {
      overlay = data;
      return Buffer.alloc(0);
    };
    const diff = diffRasters(base.raster, head.raster, {}, { probe, encode: capture });
    const encoding = performance.now();
    if (overlay)
      await encodeWith(args.overlay, { data: overlay, width: diff.width, height: diff.height });
    phases.overlay_encode = performance.now() - encoding;
    const diffMs = performance.now() - diffing;
    const out: ImplOutput = {
      verdict: diff.changed ? "changed" : "unchanged",
      regions: changeRegions(diff),
      decode_ms: decodeMs,
      diff_ms: diffMs,
      phases,
    };
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
