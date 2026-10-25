/**
 * The diff, with its hot loops in WebAssembly (PS-204; the only diff since PS-210). The Rust in
 * `engines/wasm` unfilters and expands both PNGs, runs the pixel loop, finds the blob boxes and
 * runs the overlay encode's filter pass (PS-205); inflate and deflate stay in the runtime's zlib,
 * and everything after the boxes (merging, noise, shift labels, floors) is `measuredDiff`. The
 * chunk walk is `png-walk.ts`, pngjs's reader down to its error messages. There is no JS fallback:
 * a module that will not load or instantiate fails with an error that names it.
 */
import { constants, deflateSync, inflateSync } from "node:zlib";
import { diffModule } from "#diff-module";
import type { DiffIgnore, DiffOptions, PixelDiff } from "./diff.ts";
import { type WasmPhases, timed, untimed } from "./diff-phases.ts";
import type { Raster } from "./diff-probe.ts";
import { clipRects, ignoreMask } from "./ignore-mask.ts";
import { DEFAULT_THRESHOLD, measuredDiff } from "./measured.ts";
import { type Png, SIGNATURE, plainChannels, walkPng } from "./png-walk.ts";
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
  inflated_len(
    width: number,
    height: number,
    depth: number,
    colour: number,
    interlace: number,
  ): number;
  decode(
    src: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    interlace: number,
    palette: number,
    entries: number,
    transN: number,
    t0: number,
    t1: number,
    t2: number,
    dst: number,
  ): number;
  filter(src: number, width: number, height: number, dst: number): number;
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

/**
 * The inflated lines, `size` bytes, as pngjs inflates them: Adam7 through a plain `inflateSync`,
 * otherwise through its capped inflate, which keeps the first `size` bytes and stops there, so a
 * stream with more data, or cut off after the image, still reads.
 */
function inflateLines(data: Buffer, size: number, interlaced: boolean): Buffer {
  let inflated: Buffer;
  try {
    inflated = inflateSync(data);
  } catch (error) {
    if (interlaced) throw error;
    const flushed = inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
    if (flushed.length < size) throw error;
    inflated = flushed;
  }
  if (inflated.length === 0) throw new Error("bad png - invalid inflate data response");
  if (inflated.length < size) throw new Error("bad png - inflated data is shorter than the image");
  return inflated.length === size ? inflated : inflated.subarray(0, size);
}

/** The first line's filter type pngjs refuses, in the fast path's rows at `raw`. */
function badFilter(wasm: DiffExports, raw: number, stride: number, height: number): number {
  const rows = new Uint8Array(wasm.memory.buffer, raw, stride * height);
  for (let y = 0; y < height; y++) if ((rows[y * stride] ?? 0) > 4) return rows[y * stride] ?? 0;
  return 0;
}

/** The palette copied into wasm memory as RGBA entries (0: none). */
function paletteAt(wasm: DiffExports, png: Png): number {
  if (png.palette.length === 0) return 0;
  const at = alloc(wasm, png.palette.length * 4);
  new Uint8Array(wasm.memory.buffer, at, png.palette.length * 4).set(png.palette.flat());
  return at;
}

/** `decode`'s code for the lines at `raw` taken to RGBA at `rgba`: 0, or the error's code. */
function decodeLines(wasm: DiffExports, png: Png, raw: number, rgba: number): number {
  const { width, height, depth, colour, interlace, palette, trans } = png;
  const [t0 = 0, t1 = 0, t2 = 0] = trans;
  const at = paletteAt(wasm, png);
  const shape = [width, height, depth, colour, interlace] as const;
  return wasm.decode(raw, ...shape, at, palette.length, trans.length, t0, t1, t2, rgba);
}

/** Unfilter and expand the inflated lines at `raw` to RGBA at `rgba`, or throw pngjs's error. */
function expand(wasm: DiffExports, png: Png, raw: number, rgba: number) {
  const { width, height } = png;
  const plain = plainChannels(png);
  if (plain) {
    const code = wasm.unfilter(raw, width, height, plain, rgba);
    if (code === 0) return;
    if (code === 2) throw new Error("diff.wasm: memory is full");
    const filter = badFilter(wasm, raw, width * plain + 1, height);
    throw new Error(`Unrecognised filter type - ${filter}`);
  }
  const code = decodeLines(wasm, png, raw, rgba);
  if (code >= 0x200) throw new Error(`index ${code & 0xff} not in palette`);
  if (code >= 0x100) throw new Error(`Unrecognised filter type - ${code & 0xff}`);
}

/** Decode `bytes` into a fresh RGBA buffer in wasm memory; its address. */
function decodeInto(
  wasm: DiffExports,
  bytes: Buffer,
  phases?: WasmPhases,
): { at: number; width: number; height: number } {
  const scratch = wasm.mark();
  const file = alloc(wasm, bytes.length);
  new Uint8Array(wasm.memory.buffer, file, bytes.length).set(bytes);
  const png = walkPng(bytes, (at, len) => wasm.crc32(file + at, len));
  wasm.rewind(scratch);
  const { width, height, depth, colour, interlace } = png;
  const rgba = alloc(wasm, width * height * 4);
  const lines = wasm.mark();
  const [only] = png.idat;
  const size = wasm.inflated_len(width, height, depth, colour, interlace);
  const data = png.idat.length === 1 && only ? only : Buffer.concat(png.idat);
  const inflated = timed(phases, "decode_inflate", () => inflateLines(data, size, interlace === 1));
  const raw = alloc(wasm, size);
  new Uint8Array(wasm.memory.buffer, raw, size).set(inflated);
  release(inflated);
  timed(phases, "decode_unfilter", () => expand(wasm, png, raw, rgba));
  wasm.rewind(lines);
  return { at: rgba, width, height };
}

/** pngjs's deflate options for `PNG.sync.write`: level 9, Z_RLE, 32 KiB chunks. */
const DEFLATE = { chunkSize: 32 * 1024, level: 9, strategy: 3 };

/**
 * The RGBA overlay at `at` as the PNG `PNG.sync.write` writes, byte for byte: the rows filtered in
 * wasm, deflated in the runtime's zlib with pngjs's options, then IHDR (8-bit RGBA), one IDAT and
 * IEND. Grows the memory, so it runs before any view of it is made.
 */
function encodeOverlay(wasm: DiffExports, at: number, width: number, height: number): Buffer {
  const scratch = wasm.mark();
  const rowsLen = (width * 4 + 1) * height;
  const rows = alloc(wasm, rowsLen);
  if (wasm.filter(at, width, height, rows) !== 0) throw new Error("diff.wasm: memory is full");
  const idat = deflateSync(new Uint8Array(wasm.memory.buffer, rows, rowsLen), DEFLATE);
  wasm.rewind(scratch);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    ["IHDR", ihdr],
    ["IDAT", idat],
    ["IEND", Buffer.alloc(0)],
  ] as const;
  const length = SIGNATURE.length + parts.reduce((sum, [, data]) => sum + 12 + data.length, 0);
  const file = alloc(wasm, length);
  const png = Buffer.from(wasm.memory.buffer, file, length);
  png.set(SIGNATURE);
  let pos = SIGNATURE.length;
  for (const [type, data] of parts) {
    png.writeUInt32BE(data.length, pos);
    png.write(type, pos + 4, "latin1");
    png.set(data, pos + 8);
    png.writeUInt32BE(wasm.crc32(file + pos + 4, 4 + data.length) >>> 0, pos + 8 + data.length);
    pos += 12 + data.length;
  }
  const copy = Buffer.from(png);
  wasm.rewind(scratch);
  return copy;
}

function alloc(wasm: DiffExports, len: number): number {
  const at = wasm.alloc(len);
  if (at === 0) throw new Error("diff.wasm: memory is full");
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

/** What `wasmDiff` takes beside the pair: `encode` replaces the overlay's PNG encode. */
type WasmDiffOptions = {
  options?: DiffOptions;
  ignore?: DiffIgnore;
  encode?: ((overlay: Raster) => Buffer) | undefined;
  /** Filled with where the time went, when given (the bench's phase split). */
  phases?: WasmPhases | undefined;
};

function run(
  wasm: DiffExports,
  [main, branch]: [Buffer, Buffer],
  { options = {}, ignore = {}, encode, phases }: WasmDiffOptions,
): PixelDiff & { overlay: Buffer } {
  wasm.reset();
  // The chunk walk and the copies into the module are decode_other.
  const ma = untimed(phases, "decode_other", () => decodeInto(wasm, main, phases));
  const br = untimed(phases, "decode_other", () => decodeInto(wasm, branch, phases));
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
  const shots = [ma.at, ma.width, ma.height, br.at, br.width, br.height] as const;
  timed(phases, "pixel_compare", () => wasm.diff(...shots, skip, maxDelta, field, overlay, out));
  const gap = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
  const count = timed(phases, "regions", () => wasm.blob_boxes(field, width, height, gap, out + 8));
  if (count === 0xffffffff) throw new Error("diff.wasm: memory is full");
  let encodeWith = encode;
  if (!encodeWith) {
    const png = timed(phases, "overlay_encode", () =>
      encodeOverlay(wasm, overlay, overlayWidth, overlayHeight),
    );
    encodeWith = () => png;
  }
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
  return timed(phases, "regions", () =>
    measuredDiff(
      [a, b],
      raster,
      { changedPixels, antialiased, ignoredPixels, ignored, field: fieldOf },
      { options, blobs: () => boxes, encode: encodeWith },
    ),
  );
}

const EXPORTS = [
  "reset",
  "mark",
  "rewind",
  "alloc",
  "crc32",
  "unfilter",
  "inflated_len",
  "decode",
  "filter",
  "diff",
  "blob_boxes",
];

function isDiffExports(exports: WebAssembly.Instance["exports"]): exports is DiffExports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    EXPORTS.every((name) => typeof exports[name] === "function")
  );
}

function instantiate(module: WebAssembly.Module): DiffExports {
  let exports: WebAssembly.Instance["exports"];
  try {
    ({ exports } = new WebAssembly.Instance(module));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`diff.wasm will not instantiate: ${why}`, { cause: error });
  }
  if (!isDiffExports(exports)) throw new Error("diff.wasm does not export the diff");
  return exports;
}

const size = ({ width, height }: { width: number; height: number }) => ({ width, height });

/** One instance, made on first use and reused: its memory stays at the largest diff's size. */
let wasm: DiffExports | null = null;

/**
 * Decode and diff the pair in `diff.wasm`. Always measures and always draws the overlay; the
 * identical-bytes shortcut is `diffPngs`'s. `encode` replaces the overlay's PNG encode (the bench's
 * `--overlay none` captures the raster instead); left out, it is pngjs's encode, byte for byte.
 * Any error drops the instance, so the next diff starts on a fresh one.
 */
export function wasmDiff(
  pair: [Buffer, Buffer],
  options: WasmDiffOptions = {},
): PixelDiff & { overlay: Buffer } {
  try {
    wasm ??= instantiate(diffModule());
    return run(wasm, pair, options);
  } catch (error) {
    wasm = null;
    throw error;
  }
}
