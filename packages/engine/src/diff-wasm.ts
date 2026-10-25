/**
 * The server diff with its hot loops in WebAssembly (PS-204, a spike behind a flag). The Rust in
 * `engines/wasm` unfilters both PNGs, runs the pixel loop and finds the blob boxes; inflate stays
 * in the runtime's zlib, and everything after the boxes (merging, noise, shift labels, floors, the
 * overlay's encode) is the engine's own `measuredDiff`. The result is byte-identical to
 * `diffPngs`, and any PNG the fast path does not read falls back to `diffPngs` whole.
 */
import { inflateSync } from "node:zlib";
import {
  type DiffIgnore,
  type DiffOptions,
  DEFAULT_THRESHOLD,
  type PixelDiff,
  diffPngs,
  measuredDiff,
} from "./diff.ts";
import type { Raster } from "./diff-probe.ts";
import { identicalBytes } from "./identical.ts";
import { clipRects, ignoreMask } from "./ignore-mask.ts";
import { type Box, DEFAULT_MERGE_DISTANCE, type DiffField } from "./regions.ts";
import { release } from "./release.ts";
import { MAX_YIQ_DELTA } from "./yiq.ts";

/** The exports of `engines/wasm/src/lib.rs`; addresses and sizes are byte offsets in `memory`. */
type DiffExports = {
  memory: WebAssembly.Memory;
  reset(): void;
  mark(): number;
  rewind(to: number): void;
  alloc(len: number): number;
  crc32(ptr: number, len: number): number;
  unfilter(src: number, width: number, height: number, channels: number, dst: number): number;
  diff(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    skip: number,
    maxDelta: number,
    field: number,
    overlay: number,
    out: number,
  ): void;
  blob_boxes(kind: number, width: number, height: number, gap: number, out: number): number;
};

type DiffFn = typeof diffPngs;

/** A PNG the fast path reads: 8-bit RGB or RGBA, not interlaced, and nothing that changes pixels. */
type SimplePng = { width: number; height: number; channels: 3 | 4; idat: Buffer[] };

/** A chunk whose CRC pngjs checks, so the fast path checks it too: [start of type, length]. */
type Checked = [number, number];

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Chunk = { type: string; at: number; length: number; data: Buffer };

/** Every chunk up to and including IEND, or null when the file is not one whole PNG. */
function chunksOf(png: Buffer): Chunk[] | null {
  if (png.length < 8 || SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  const chunks: Chunk[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > png.length) return null;
    const type = png.toString("latin1", at + 4, at + 8);
    chunks.push({ type, at, length, data: png.subarray(at + 8, at + 8 + length) });
    if (type === "IEND") return end === png.length ? chunks : null;
    at = end;
  }
  return null;
}

/** The chunks whose CRC pngjs checks, so the fast path checks them too. */
const CHECKED = new Set(["IHDR", "IDAT", "gAMA", "IEND"]);

/** A chunk after IHDR that pngjs reads the way the fast path does. */
function fastChunk({ type, length }: Chunk): boolean {
  if (type === "IDAT") return true;
  // pngjs reads gamma into metadata and never applies it to the pixels.
  if (type === "gAMA") return length === 4;
  if (type === "IEND") return length === 0;
  // Ancillary (lower-case first letter) and not one that changes the pixels; a critical chunk
  // pngjs does not know makes it throw.
  return (type.charCodeAt(0) & 0x20) !== 0 && type !== "tRNS";
}

/**
 * The parts of `png` the fast path needs, or null when pngjs might read it differently: another
 * depth or colour type, interlace, a palette or transparency chunk, an unknown critical chunk,
 * anything after IEND. Null is not an error: `diffPngs` then decodes it, or refuses it, as always.
 */
function simplePng(png: Buffer): { png: SimplePng; checked: Checked[] } | null {
  const chunks = chunksOf(png) ?? [];
  const [ihdr, ...rest] = chunks;
  if (ihdr?.type !== "IHDR" || ihdr.length !== 13) return null;
  const header = ihdrOf(ihdr.data);
  const idat = rest.filter((c) => c.type === "IDAT").map((c) => c.data);
  if (!header || idat.length === 0 || !rest.every(fastChunk)) return null;
  const checked = chunks
    .filter((c) => CHECKED.has(c.type))
    .map((c): Checked => [c.at + 4, c.length]);
  return { png: { ...header, idat }, checked };
}

function ihdrOf(data: Buffer): Omit<SimplePng, "idat"> | null {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const [depth, colorType, compression, filter, interlace] = data.subarray(8, 13);
  if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
  if (colorType !== 6 && colorType !== 2) return null;
  if (width === 0 || height === 0) return null;
  return { width, height, channels: colorType === 6 ? 4 : 3 };
}

/** Thrown inside the fast path when it must hand the pair to `diffPngs`. */
class NotFast extends Error {}

/** Decode `bytes` into a fresh RGBA buffer in wasm memory; its address. */
function decodeInto(
  wasm: DiffExports,
  bytes: Buffer,
): { at: number; width: number; height: number } {
  const parsed = simplePng(bytes);
  if (!parsed) throw new NotFast("not a simple PNG");
  const { width, height, channels, idat } = parsed.png;
  const rgba = alloc(wasm, width * height * 4);
  const scratch = wasm.mark();
  const file = alloc(wasm, bytes.length);
  new Uint8Array(wasm.memory.buffer, file, bytes.length).set(bytes);
  const view = new DataView(wasm.memory.buffer);
  for (const [type, length] of parsed.checked) {
    const crc = wasm.crc32(file + type, 4 + length) >>> 0;
    if (crc !== view.getUint32(file + type + 4 + length)) throw new NotFast("CRC mismatch");
  }
  wasm.rewind(scratch);
  const [only] = idat;
  const inflated = inflateSync(idat.length === 1 && only ? only : Buffer.concat(idat));
  const rows = (width * channels + 1) * height;
  if (inflated.length !== rows) throw new NotFast("inflated size is not the image's");
  const raw = alloc(wasm, rows);
  new Uint8Array(wasm.memory.buffer, raw, rows).set(inflated);
  release(inflated);
  if (wasm.unfilter(raw, width, height, channels, rgba) !== 0) throw new NotFast("bad filter");
  wasm.rewind(scratch);
  return { at: rgba, width, height };
}

function alloc(wasm: DiffExports, len: number): number {
  const at = wasm.alloc(len);
  if (at === 0) throw new NotFast("wasm memory is full");
  return at;
}

function boxesAt(wasm: DiffExports, at: number, count: number): Box[] {
  const cells = new Uint32Array(wasm.memory.buffer, at, count * 4);
  const boxes: Box[] = [];
  for (let i = 0; i < count * 4; i += 4) {
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = cells.subarray(i, i + 4);
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

/** The ignore areas clipped to the overlap, and their mask copied into wasm memory (0: none). */
function skipMask(wasm: DiffExports, ignore: DiffIgnore, width: number, height: number) {
  const ignored = clipRects([...(ignore.main ?? []), ...(ignore.branch ?? [])], width, height);
  const mask = ignored.length > 0 ? ignoreMask(ignored, width, height) : null;
  if (!mask) return { ignored, skip: 0, count: 0 };
  const skip = alloc(wasm, width * height);
  new Uint8Array(wasm.memory.buffer, skip, width * height).set(mask.mask);
  return { ignored, skip, count: mask.count };
}

function fastDiff(
  wasm: DiffExports,
  [main, branch]: [Buffer, Buffer],
  options: DiffOptions,
  ignore: DiffIgnore,
): PixelDiff {
  wasm.reset();
  const ma = decodeInto(wasm, main);
  const br = decodeInto(wasm, branch);
  const width = Math.min(ma.width, br.width);
  const height = Math.min(ma.height, br.height);
  const n = width * height;
  const overlayWidth = Math.max(ma.width, br.width);
  const overlayHeight = Math.max(ma.height, br.height);
  const overlayLen = overlayWidth * overlayHeight * 4;
  const overlay = alloc(wasm, overlayLen);
  const field = alloc(wasm, n * 3);
  const { ignored, skip, count: ignoredPixels } = skipMask(wasm, ignore, width, height);
  const out = alloc(wasm, 12);
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxDelta = MAX_YIQ_DELTA * threshold * threshold;
  wasm.diff(
    ma.at,
    ma.width,
    ma.height,
    br.at,
    br.width,
    br.height,
    skip,
    maxDelta,
    field,
    overlay,
    out,
  );
  const gap = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
  const count = wasm.blob_boxes(field, width, height, gap, out + 8);
  if (count === 0xffffffff) throw new NotFast("wasm memory is full");
  // Views only now: a call that grows the memory detaches every view made before it.
  const memory = wasm.memory.buffer;
  const [boxesPtr = 0] = new Uint32Array(memory, out + 8, 1);
  const boxes = boxesAt(wasm, boxesPtr, count);
  const [changedPixels = 0, antialiased = 0] = new Uint32Array(memory, out, 2);
  const a: Raster = { data: new Uint8Array(memory, ma.at, ma.width * ma.height * 4), ...size(ma) };
  const b: Raster = { data: new Uint8Array(memory, br.at, br.width * br.height * 4), ...size(br) };
  const fieldOf: DiffField = {
    width,
    height,
    kind: new Uint8Array(memory, field, n),
    amplitude: new Uint8Array(memory, field + n, n),
    lighter: new Uint8Array(memory, field + 2 * n, n),
  };
  const raster: Raster = {
    data: new Uint8Array(memory, overlay, overlayLen),
    width: overlayWidth,
    height: overlayHeight,
  };
  return measuredDiff(
    [a, b],
    raster,
    {
      changedPixels,
      antialiased,
      ignoredPixels,
      ignored,
      field: fieldOf,
    },
    { options, blobs: () => boxes },
  );
}

const EXPORTS = ["reset", "mark", "rewind", "alloc", "crc32", "unfilter", "diff", "blob_boxes"];

function isDiffExports(exports: WebAssembly.Instance["exports"]): exports is DiffExports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    EXPORTS.every((name) => typeof exports[name] === "function")
  );
}

function instantiate(module: WebAssembly.Module): DiffExports {
  const { exports } = new WebAssembly.Instance(module);
  if (!isDiffExports(exports)) throw new Error("diff.wasm does not export the diff");
  return exports;
}

const size = ({ width, height }: { width: number; height: number }) => ({ width, height });

/**
 * `diffPngs` with the hot loops in `module` (the compiled `diff.wasm`). One instance per differ,
 * reused: its memory stays at the largest diff's size. A failure inside the fast path drops the
 * instance and the pair goes to `diffPngs`, which gives the same answer or the same error;
 * `fellBack` is told why (the tests use it to prove the fast path ran).
 */
export function wasmDiffer(
  module: WebAssembly.Module,
  { fellBack }: { fellBack?: (reason: unknown) => void } = {},
): DiffFn {
  let wasm: DiffExports | null = null;
  function diff(
    main: Buffer,
    branch: Buffer,
    options: DiffOptions = {},
    ignore: DiffIgnore = {},
  ): PixelDiff {
    const same = identicalBytes(main, branch);
    if (same) return same;
    try {
      wasm ??= instantiate(module);
      return fastDiff(wasm, [main, branch], options, ignore);
    } catch (error) {
      if (!(error instanceof NotFast)) wasm = null;
      fellBack?.(error);
      return diffPngs(main, branch, options, ignore);
    }
  }
  return diff;
}
