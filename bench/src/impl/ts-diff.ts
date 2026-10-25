#!/usr/bin/env bun
/**
 * The TypeScript engine behind the diff contract (ob 1909): the baseline, and the reference
 * implementation of the contract in `bench/README.md`.
 *
 *   bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json
 *     [--engine ts|wasm] [--decode parallel|sequential] [--decoder <name>] [--overlay <name>]
 *
 * It decodes the two files itself with `--decoder`: by default napi-image, the fastest permissive
 * one measured (PS-168); pngjs, the engine's own, is split into phases in `ts-decode.ts`. It hands
 * the pixels to the engine's `diffRasters`, the call `diffPngs` makes after its own decode, so the
 * verdict and regions are the engine's. `decode_ms` is reading and decoding both files, `diff_ms`
 * is the `diffRasters` call (pixel diff and region clustering) plus encoding the overlay with
 * `--overlay`. The contract does not ask for the overlay, so the default is `none`, which encodes
 * nothing (PS-168); `--overlay pngjs` is what the engine itself does. `phases` splits both. The
 * names are in `ts-codecs.ts`. Exit 2 on bad usage, 1 when a file cannot be read or decoded.
 *
 * `--engine wasm` (PS-209) runs the server's WASM diff (`DIFF_WASM`, PS-204) instead, through
 * `wasmDiffer`. It decodes inside the same call as the pixel loop, so its `diff_ms` holds the
 * inflate, the unfilter and the compare together, and `decode_ms` is the file read alone. It has no
 * decoder of its own to choose, so `--decoder` is refused with it; `--decode` is ignored.
 */
// The diff entry, not the package root: the root also exports capture, which loads Playwright.
import { readFileSync } from "node:fs";
import { diffRasters } from "@pixelslash/engine/diff";
import { wasmDiffer } from "@pixelslash/engine/diff-wasm";
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
  "usage: ts-diff.ts [--engine ts|wasm] [--decoder <name>] [--overlay <name>] [--decode parallel|sequential] diff <base.png> <head.png> --json";

export const DEFAULT_DECODER: DecoderName = "napi-image";
export const DEFAULT_OVERLAY: OverlayName = "none";

/** The compiled `diff.wasm` the server ships (`packages/engine/wasm`), read when `--engine wasm` runs. */
const WASM_PATH = new URL("../../../packages/engine/wasm/diff.wasm", import.meta.url);

type Engine = "ts" | "wasm";

type Args = {
  basePath: string;
  headPath: string;
  engine: Engine;
  parallel: boolean;
  decoder: DecoderName;
  overlay: OverlayName;
};

const SWITCHES = ["--decode", "--decoder", "--overlay", "--engine"];

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

const isEngine = (value: string): value is Engine => value === "ts" || value === "wasm";
const isMode = (value: string): value is "parallel" | "sequential" =>
  value === "parallel" || value === "sequential";

/** The switches' values, defaulted; null when one is not a known name or the pair does not fit. */
function switchValues(seen: Map<string, string>): Omit<Args, "basePath" | "headPath"> | null {
  const engine = pick(seen, "--engine", "ts", isEngine);
  const mode = pick(seen, "--decode", "sequential", isMode);
  const decoder = pick(seen, "--decoder", DEFAULT_DECODER, isDecoder);
  const overlay = pick(seen, "--overlay", DEFAULT_OVERLAY, isOverlay);
  if (!engine || !mode || !decoder || !overlay) return null;
  // The WASM engine decodes inside its own call, so there is no decoder for `--decoder` to pick.
  if (engine === "wasm" && seen.has("--decoder")) return null;
  return { engine, parallel: mode === "parallel", decoder, overlay };
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

/** The TypeScript engine: its own decoder, then `diffRasters`. */
async function diffTs(args: Args): Promise<ImplOutput> {
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
  return {
    verdict: diff.changed ? "changed" : "unchanged",
    regions: changeRegions(diff),
    decode_ms: decodeMs,
    diff_ms: diffMs,
    phases,
  };
}

/** The server's WASM diff (`wasmDiffer`, PS-204): decode, unfilter and compare in one call. */
async function diffWasm(args: Args): Promise<ImplOutput> {
  const module = new WebAssembly.Module(readFileSync(WASM_PATH));
  // The same capture as `diffTs`: the engine's encode is swapped, so `--overlay` alone decides.
  let overlay: Uint8Array | null = null;
  const capture = ({ data }: { data: Uint8Array }) => {
    overlay = data;
    return Buffer.alloc(0);
  };
  const diff = wasmDiffer(module, {
    // A pair the fast path declines would carry pngjs's verdict under the wasm label: refuse it.
    fellBack: (reason) => {
      throw new Error(
        `ts-diff: wasm declined the pair (${reason instanceof Error ? reason.message : String(reason)}), so it is not timed as wasm`,
      );
    },
    encode: capture,
  });
  const reading = performance.now();
  const baseBytes = readFileSync(args.basePath);
  const headBytes = readFileSync(args.headPath);
  const decodeMs = performance.now() - reading;
  const diffing = performance.now();
  const result = diff(baseBytes, headBytes);
  const encoding = performance.now();
  if (overlay)
    await encodeWith(args.overlay, { data: overlay, width: result.width, height: result.height });
  const overlayEncodeMs = performance.now() - encoding;
  const diffMs = performance.now() - diffing;
  return {
    verdict: result.changed ? "changed" : "unchanged",
    regions: changeRegions(result),
    decode_ms: decodeMs,
    diff_ms: diffMs,
    phases: { decode_read: decodeMs, overlay_encode: overlayEncodeMs },
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
    const out = args.engine === "wasm" ? await diffWasm(args) : await diffTs(args);
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
