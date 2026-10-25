import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { diffPngs, measurePngs } from "../src/diff.ts";

const wasmPath = join(import.meta.dirname, "../wasm/diff.wasm");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

type Manifest = { sources: Record<string, string>; wasm: string };

function isManifest(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && "sources" in value && "wasm" in value;
}

describe("diff.wasm is what engines/wasm builds (PS-204)", () => {
  // The gate has no Rust: `bun run wasm:build` records each input's hash beside the module, and a
  // source edited without a rebuild fails here. `bun run wasm:check` rebuilds and compares bytes.
  const manifest: unknown = JSON.parse(readFileSync(`${wasmPath}.json`, "utf8"));
  if (!isManifest(manifest)) throw new Error("diff.wasm.json is not a build manifest");
  const root = join(import.meta.dirname, "../../..");

  test.each(Object.entries(manifest.sources))("%s is unchanged since the build", (path, hash) => {
    expect(sha256(join(root, path))).toBe(hash);
  });

  test("the committed module is the built one", () => {
    expect(sha256(wasmPath)).toBe(manifest.wasm);
  });
});

const corpusRoot = join(import.meta.dirname, "../../../bench");
const golden: Record<string, Golden> = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/pngjs-golden.json"), "utf8"),
);
const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const overlaySha = (overlay: Buffer | null) =>
  overlay && createHash("sha256").update(overlay).digest("hex");
const pairOf = (name: string): [Buffer, Buffer] => [
  readFileSync(join(corpusRoot, name, "base.png")),
  readFileSync(join(corpusRoot, name, "head.png")),
];

/**
 * What pngjs's `diffPngs` and `measurePngs` returned for each corpus pair before PS-210, from
 * `packages/engine/test/fixtures/pngjs-golden.json`: the whole result hashed (the overlay as its
 * sha256), and the counts and the overlay's sha256 in the clear so a mismatch says what moved.
 */
type Golden = {
  changedPixels: number;
  antialiased: number;
  regions: number;
  overlay: string;
  diff: string;
  measure: string;
};

/** The corpus tests diff whole page pairs: headroom for a loaded machine, as the other corpus tests have. */
const CORPUS_TIMEOUT = 30_000;

describe("the WASM diff gives pngjs's answer on the bench corpora (PS-210)", () => {
  test.each(Object.keys(golden))(
    "%s",
    (name) => {
      const want = golden[name];
      const [main, branch] = pairOf(name);
      const measured = measurePngs(main, branch);
      expect({
        changedPixels: measured.changedPixels,
        antialiased: measured.antialiased,
        regions: measured.regions.length,
        overlay: overlaySha(measured.overlay),
      }).toEqual({
        changedPixels: want?.changedPixels,
        antialiased: want?.antialiased,
        regions: want?.regions,
        overlay: want?.overlay,
      });
      expect(hashOf({ ...measured, overlay: overlaySha(measured.overlay) })).toBe(want?.measure);
      const diffed = diffPngs(main, branch);
      expect(hashOf({ ...diffed, overlay: overlaySha(diffed.overlay) })).toBe(want?.diff);
    },
    CORPUS_TIMEOUT,
  );

  test(
    "the corpus's overlays pick every filter type, so each choice of the wasm filter is held",
    () => {
      // PS-205: the overlay's filter pass runs in wasm and must pick pngjs's filter on every row.
      // The checks above only hold that for the filters the overlays actually choose.
      const picked = new Set<number>();
      for (const name of Object.keys(golden)) {
        const { overlay } = measurePngs(...pairOf(name));
        const { width, height } = PNG.sync.read(overlay);
        // The one IDAT both encoders write: after the signature and IHDR, before its CRC and IEND.
        const rows = inflateSync(overlay.subarray(41, overlay.length - 16));
        for (let y = 0; y < height; y++) picked.add(rows[y * (width * 4 + 1)] ?? -1);
      }
      expect([...picked].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    },
    CORPUS_TIMEOUT,
  );
});

/** An 8-bit RGBA PNG with a hand-written chunk list, for the shapes pngjs never writes. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function crc32(bytes: Buffer): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function handMade(extra: Buffer[], width = 4, height = 3): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x7f);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  const idat = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", idat.subarray(0, 5)),
    chunk("IDAT", idat.subarray(5)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pack one row of samples at `depth` bits each, most significant first, as PNG does. */
function packRow(samples: number[], depth: number): number[] {
  if (depth === 8) return samples;
  if (depth === 16) return samples.flatMap((v) => [v >> 8, v & 0xff]);
  const bytes = Array.from<number>({ length: Math.ceil((samples.length * depth) / 8) }).fill(0);
  samples.forEach((v, i) => {
    const bit = i * depth;
    bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (v << (8 - depth - (bit & 7)));
  });
  return bytes;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/**
 * A PNG in a shape pngjs's encoder never writes: any colour type and bit depth, optionally Adam7,
 * with PLTE and tRNS when given. `sample(x, y)` is the pixel's samples at that depth.
 */
function exotic(
  [width, height]: [number, number],
  { depth, colour, interlace = 0 }: { depth: number; colour: number; interlace?: number },
  sample: (x: number, y: number) => number[],
  extra: Buffer[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, interlace], 8);
  const passes = interlace ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const raw: number[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    for (let y = y0; y < height; y += dy) {
      const row: number[] = [];
      for (let x = x0; x < width; x += dx) row.push(...sample(x, y));
      if (row.length > 0) raw.push(0, ...packRow(row, depth));
    }
  }
  expect(CHANNELS[colour]).toBeDefined();
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The file pngjs's `PNG.sync.read` makes of `png`, written back as plain 8-bit RGBA. */
const asPngjsReads = (png: Buffer) => PNG.sync.write(PNG.sync.read(png));

/**
 * `png` diffed against pngjs's reading of it: the changed pixels, and whether the overlay is the
 * one an unchanged pair draws. A PNG that decodes to pngjs's pixels gives `PNGJS_PIXELS`.
 */
function againstPngjs(png: Buffer) {
  const plain = asPngjsReads(png);
  const got = measurePngs(png, plain);
  const unchanged = overlaySha(got.overlay) === overlaySha(measurePngs(plain, plain).overlay);
  return { changed: got.changedPixels + got.antialiased, unchanged };
}
const PNGJS_PIXELS = { changed: 0, unchanged: true };

/** A sample at (x, y) in 0..max, varied enough to catch a pixel read from the wrong place. */
const v = (x: number, y: number, max: number) => (x * 7 + y * 3) % (max + 1);

/** The message pngjs throws reading `png`. */
function pngjsWords(png: Buffer): string {
  try {
    PNG.sync.read(png);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("pngjs read it");
}

describe("diff.wasm reads every PNG pngjs reads, to the same pixels (PS-210)", () => {
  const [w, h] = [11, 7];

  test.each([1, 2, 4, 8, 16])("grey at %i bits", (depth) => {
    expect(
      againstPngjs(exotic([w, h], { depth, colour: 0 }, (x, y) => [v(x, y, 2 ** depth - 1)])),
    ).toEqual(PNGJS_PIXELS);
  });

  test.each([1, 2, 4, 8])("a palette at %i bits, with tRNS", (depth) => {
    const entries = 2 ** depth;
    const plte = Buffer.from(Array.from({ length: entries * 3 }, (_, i) => (i * 37) & 0xff));
    const trns = Buffer.from(Array.from({ length: Math.min(entries, 3) }, (_, i) => i * 100));
    const png = exotic([w, h], { depth, colour: 3 }, (x, y) => [v(x, y, entries - 1)], [
      chunk("PLTE", plte),
      chunk("tRNS", trns),
    ]);
    expect(againstPngjs(png)).toEqual(PNGJS_PIXELS);
  });

  test.each([8, 16])("grey and alpha, RGB and RGBA at %i bits", (depth) => {
    const max = 2 ** depth - 1;
    expect(
      againstPngjs(exotic([w, h], { depth, colour: 4 }, (x, y) => [v(x, y, max), v(y, x, max)])),
    ).toEqual(PNGJS_PIXELS);
    expect(
      againstPngjs(exotic([w, h], { depth, colour: 2 }, (x, y) => [v(x, y, max), v(y, x, max), 3])),
    ).toEqual(PNGJS_PIXELS);
    expect(
      againstPngjs(
        exotic([w, h], { depth, colour: 6 }, (x, y) => [v(x, y, max), 9, v(y, x, max), x * 20]),
      ),
    ).toEqual(PNGJS_PIXELS);
  });

  test("tRNS on grey and on RGB", () => {
    const grey = Buffer.from([0, 3]);
    expect(
      againstPngjs(exotic([w, h], { depth: 8, colour: 0 }, (x) => [x % 5], [chunk("tRNS", grey)])),
    ).toEqual(PNGJS_PIXELS);
    const rgb = Buffer.from([0, 1, 0, 2, 0, 3]);
    expect(
      againstPngjs(
        exotic([w, h], { depth: 8, colour: 2 }, (x) => [1, 2, x % 4], [chunk("tRNS", rgb)]),
      ),
    ).toEqual(PNGJS_PIXELS);
  });

  test.each([
    [1, 0],
    [4, 3],
    [8, 6],
    [16, 2],
  ])("Adam7 at %i bits, colour type %i", (depth, colour) => {
    const max = 2 ** depth - 1;
    const channels = CHANNELS[colour] ?? 1;
    const plte = Buffer.from(Array.from({ length: 16 * 3 }, (_, i) => (i * 53) & 0xff));
    for (const [width, height] of [
      [w, h],
      [1, 1],
      [3, 9],
    ] as [number, number][]) {
      const png = exotic(
        [width, height],
        { depth, colour, interlace: 1 },
        (x, y) => Array.from({ length: channels }, (_, c) => v(x + c, y, colour === 3 ? 15 : max)),
        colour === 3 ? [chunk("PLTE", plte)] : [],
      );
      expect(againstPngjs(png)).toEqual(PNGJS_PIXELS);
    }
  });

  test("split IDAT, gAMA and an unknown ancillary chunk", () => {
    const gama = Buffer.alloc(4);
    gama.writeUInt32BE(45455);
    expect(
      againstPngjs(handMade([chunk("gAMA", gama), chunk("teXt", Buffer.from("a\0b"))])),
    ).toEqual(PNGJS_PIXELS);
  });

  test("narrow and odd widths, and every filter pngjs writes: the overlay is pngjs's encode", () => {
    let seed = 7;
    const noise = (width: number, height: number, filterType = -1) => {
      const png = new PNG({ width, height });
      for (let i = 0; i < png.data.length; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        // Mostly opaque, with some alpha: the overlay's encode must keep both.
        const alpha = i % 28 === 3 ? seed >>> 25 : 255;
        png.data[i] = i % 4 === 3 ? alpha : seed >>> 24;
      }
      return PNG.sync.write(png, { filterType });
    };
    for (const width of [1, 2, 3, 4, 5, 7, 8, 9, 13, 33]) {
      const { overlay } = measurePngs(noise(width, 5), noise(width, 5));
      // pngjs reading the overlay and writing it again gives the same bytes: it is pngjs's encode.
      expect(asPngjsReads(overlay).equals(overlay)).toBe(true);
    }
    for (const filterType of [0, 1, 2, 3, 4])
      expect(againstPngjs(noise(20, 6, filterType))).toEqual(PNGJS_PIXELS);
  });
});

describe("diff.wasm refuses what pngjs refuses, with pngjs's words (PS-210)", () => {
  const other = PNG.sync.write(new PNG({ width: 4, height: 3 }));

  test("a broken PNG", () => {
    const broken = handMade([]);
    broken.writeUInt8(broken.readUInt8(broken.length - 20) ^ 0xff, broken.length - 20);
    expect(() => PNG.sync.read(broken)).toThrow("unrecognised content at end of stream");
    expect(() => diffPngs(broken, other)).toThrow("unrecognised content at end of stream");
  });

  test("not a PNG, and a bad CRC", () => {
    const notPng = Buffer.from("not a png at all, just text");
    expect(() => diffPngs(notPng, other)).toThrow(pngjsWords(notPng));
    const badCrc = handMade([]);
    badCrc.writeUInt8(badCrc.readUInt8(29) ^ 0xff, 29);
    expect(() => diffPngs(badCrc, other)).toThrow(pngjsWords(badCrc));
  });
});
