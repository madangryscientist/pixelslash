#!/usr/bin/env bun
/**
 * The TypeScript engine behind the diff contract (ob 1909): the baseline, and the reference
 * implementation of the contract in `bench/README.md`.
 *
 *   bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json [--decode parallel|sequential]
 *
 * It decodes the two files itself (pngjs, timed in `ts-decode.ts`) and hands the pixels to the
 * engine's `diffRasters`, the call `diffPngs` makes after its own decode, so the verdict and regions
 * are the engine's. `decode_ms` is reading and decoding both files, `diff_ms` is the `diffRasters`
 * call (pixel diff, region clustering and the overlay PNG the engine always encodes, which the
 * contract does not ask of anyone); `phases` splits both. Exit 2 on bad usage, 1 when a file cannot
 * be read or decoded.
 */
import { diffRasters, type DiffPhase } from "@pixelslash/engine";
import { SPAWN_AT_ENV, type ImplOutput } from "./contract.ts";
import { changeRegions } from "../pixelslash.ts";
import { say, warn } from "../say.ts";
import { addTimes, decodeFile, type Decoded } from "./ts-decode.ts";
import type { WorkerReply } from "./ts-decode-worker.ts";

const USAGE = "usage: ts-diff.ts diff <base.png> <head.png> --json [--decode parallel|sequential]";

type Args = { basePath: string; headPath: string; parallel: boolean };

function parseArgs(argv: string[]): Args | null {
  const [verb, basePath, headPath, flag, ...rest] = argv;
  if (verb !== "diff" || !basePath || !headPath || flag !== "--json") return null;
  if (rest.length === 0) return { basePath, headPath, parallel: false };
  const [name, mode, ...more] = rest;
  if (name !== "--decode" || more.length > 0) return null;
  if (mode !== "parallel" && mode !== "sequential") return null;
  return { basePath, headPath, parallel: mode === "parallel" };
}

/** Head on a worker thread, base on this one; the worker's start-up is part of the wall time. */
async function decodeBoth(basePath: string, headPath: string): Promise<[Decoded, Decoded]> {
  const worker = new Worker(new URL("./ts-decode-worker.ts", import.meta.url));
  try {
    const head = new Promise<Decoded>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
        if (event.data.ok) resolve(event.data.decoded);
        else reject(new Error(event.data.message));
      });
      worker.addEventListener("error", (event) => reject(new Error(event.message)));
    });
    worker.postMessage(headPath, { transfer: [] });
    const base = decodeFile(basePath);
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
      ? await decodeBoth(args.basePath, args.headPath)
      : [decodeFile(args.basePath), decodeFile(args.headPath)];
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
    const diff = diffRasters(base.raster, head.raster, {}, { probe });
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
    say(JSON.stringify(out));
    return 0;
  } catch (e) {
    warn(`ts-diff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
