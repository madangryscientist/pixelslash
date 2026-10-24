#!/usr/bin/env bun
/**
 * The TypeScript engine behind the diff contract (ob 1909): the baseline, and the reference
 * implementation of the contract in `bench/README.md`.
 *
 *   bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json
 *
 * `diffPngs` (through `pixelslashDiff`) decodes inside its own call, so the two times are made to add up to it: `decode_ms` is
 * a timed read and decode of both files, `diff_ms` is the rest of the `diffPngs` call (pixel diff, region
 * clustering and the overlay PNG the engine always encodes, which the contract does not ask of
 * anyone). Exit 2 on bad usage, 1 when a file cannot be read or decoded.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { ImplOutput } from "./contract.ts";
import { pixelslashDiff } from "../pixelslash.ts";
import { say, warn } from "../say.ts";

const USAGE = "usage: ts-diff.ts diff <base.png> <head.png> --json";

function main(argv: string[]): number {
  const [verb, basePath, headPath, flag, ...rest] = argv;
  if (verb !== "diff" || !basePath || !headPath || flag !== "--json" || rest.length > 0) {
    warn(USAGE);
    return 2;
  }
  let base: Buffer;
  let head: Buffer;
  try {
    const decoding = performance.now();
    base = readFileSync(basePath);
    head = readFileSync(headPath);
    PNG.sync.read(base);
    PNG.sync.read(head);
    const decodeMs = performance.now() - decoding;
    // The same call `bench` scores in process, so the verdict and regions cannot drift from it.
    const diff = pixelslashDiff(base, head);
    const out: ImplOutput = {
      verdict: diff.changed ? "changed" : "unchanged",
      regions: diff.regions,
      decode_ms: decodeMs,
      diff_ms: Math.max(0, (diff.ms ?? 0) - decodeMs),
    };
    say(JSON.stringify(out));
    return 0;
  } catch (e) {
    warn(`ts-diff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
