/**
 * pngjs's synchronous decode with its boundaries timed (ob 1932). `PNG.sync.read` is one call, so
 * the two stages that make up most of it are timed where they happen: the zlib inflate
 * (`Inflate.prototype._processChunk`) and the row unfilter (`filter-parse-sync`'s `process`), both
 * wrapped once at load. The decoder itself is not replaced: the wrappers call straight through, and
 * pngjs's own `PNG.sync.read` does the decode. What is left of the call (chunk walk, CRC, to-bitmap,
 * colour normalisation) is `other`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Raster } from "@pixelslash/engine";
import { PNG } from "pngjs";
import { decodeWith, type DecoderName } from "./ts-codecs.ts";

export type DecodeTimes = { read: number; inflate: number; unfilter: number; other: number };
export type Decoded = { raster: Raster; times: DecodeTimes };

type Fn = (this: unknown, ...args: unknown[]) => unknown;
const nodeRequire = createRequire(import.meta.url);

let inflateMs = 0;
let unfilterMs = 0;

/** Replace `target[key]`, a function, with one that adds its running time to a counter and calls straight through. */
function wrap(target: object, key: string, add: (ms: number) => void): void {
  const original: unknown = Reflect.get(target, key);
  if (typeof original !== "function") throw new Error(`pngjs has no ${key} to time`);
  const timed: Fn = function (this: unknown, ...args) {
    const started = performance.now();
    try {
      return Reflect.apply(original, this, args);
    } finally {
      add(performance.now() - started);
    }
  };
  Reflect.set(target, key, timed);
}

function asObject(value: unknown, what: string): object {
  if ((typeof value === "object" || typeof value === "function") && value !== null) return value;
  throw new Error(`pngjs has no ${what}`);
}

// pngjs ships no types for its internals and has no `exports` map, so these deep paths resolve.
const syncInflate = asObject(nodeRequire("pngjs/lib/sync-inflate"), "sync-inflate");
const inflater = asObject(
  Reflect.get(asObject(Reflect.get(syncInflate, "Inflate"), "Inflate"), "prototype"),
  "Inflate.prototype",
);
wrap(inflater, "_processChunk", (ms) => {
  inflateMs += ms;
});
wrap(asObject(nodeRequire("pngjs/lib/filter-parse-sync"), "filter-parse-sync"), "process", (ms) => {
  unfilterMs += ms;
});

/**
 * Read and decode one file with `decoder` (PS-168), timing the parts. Throws what the decoder
 * throws. Only pngjs is split; any other decoder's time is all `other`.
 */
export async function decodeFile(path: string, decoder: DecoderName = "pngjs"): Promise<Decoded> {
  const started = performance.now();
  const file = readFileSync(path);
  const read = performance.now();
  if (decoder !== "pngjs") {
    const raster = await decodeWith(decoder, file);
    return {
      raster,
      times: { read: read - started, inflate: 0, unfilter: 0, other: performance.now() - read },
    };
  }
  inflateMs = 0;
  unfilterMs = 0;
  const png = PNG.sync.read(file);
  const end = performance.now();
  const inflate = inflateMs;
  const unfilter = unfilterMs;
  return {
    raster: { data: png.data, width: png.width, height: png.height },
    times: {
      read: read - started,
      inflate,
      unfilter,
      other: Math.max(0, end - read - inflate - unfilter),
    },
  };
}

export function addTimes(a: DecodeTimes, b: DecodeTimes): DecodeTimes {
  return {
    read: a.read + b.read,
    inflate: a.inflate + b.inflate,
    unfilter: a.unfilter + b.unfilter,
    other: a.other + b.other,
  };
}
