import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { DIFF_SIZES, page } from "../../../bench/src/perf/fixtures.ts";
import { type DiffIgnore, type DiffOptions, diffPngs } from "../src/diff.ts";
import { wasmDiffer } from "../src/diff-wasm.ts";

const wasmPath = join(import.meta.dirname, "../wasm/diff.wasm");
const module = new WebAssembly.Module(readFileSync(wasmPath));
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

/** A differ that fails the test when it leaves the fast path. */
function fastOnly() {
  const reasons: unknown[] = [];
  const diff = wasmDiffer(module, { fellBack: (reason) => reasons.push(reason) });
  return { diff, reasons };
}

/** Both differs agree on every field, the overlay's bytes included. */
function expectSame(
  diff: ReturnType<typeof wasmDiffer>,
  [main, branch]: [Buffer, Buffer],
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
) {
  const want = diffPngs(main, branch, options, ignore);
  const got = diff(main, branch, options, ignore);
  expect({ ...got, overlay: null }).toEqual({ ...want, overlay: null });
  expect(got.overlay?.equals(want.overlay ?? Buffer.alloc(0)) ?? want.overlay === null).toBe(true);
  return got;
}

const corpus = join(import.meta.dirname, "../../../bench/corpus");
const cases = readdirSync(corpus).filter((name) => !name.startsWith("."));

describe("wasmDiffer matches diffPngs byte for byte (PS-204)", () => {
  const { diff, reasons } = fastOnly();

  test.each(cases)("bench corpus: %s", (name) => {
    const main = readFileSync(join(corpus, name, "base.png"));
    const branch = readFileSync(join(corpus, name, "head.png"));
    expectSame(diff, [main, branch]);
    expect(reasons).toEqual([]);
  });

  test("the corpus's overlays pick every filter type, so each choice of the wasm filter is held", () => {
    // PS-205: the overlay's filter pass runs in wasm and must pick pngjs's filter on every row.
    // The byte-for-byte checks above only hold that for the filters the overlays actually choose.
    const picked = new Set<number>();
    for (const name of cases) {
      const main = readFileSync(join(corpus, name, "base.png"));
      const { overlay } = diff(main, readFileSync(join(corpus, name, "head.png")));
      if (!overlay) continue;
      const { width, height } = PNG.sync.read(overlay);
      // The one IDAT both encoders write: after the signature and IHDR, before its CRC and IEND.
      const rows = inflateSync(overlay.subarray(41, overlay.length - 16));
      for (let y = 0; y < height; y++) picked.add(rows[y * (width * 4 + 1)] ?? -1);
    }
    expect([...picked].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  test.each(Object.entries(DIFF_SIZES))(
    "perf page: %s",
    (_, { width, height }) => {
      const d = expectSame(diff, [page(width, height, 7, false), page(width, height, 7, true)]);
      expect(d.changedPixels).toBeGreaterThan(0);
      expect(reasons).toEqual([]);
    },
    60_000,
  );

  test("options and ignore areas", () => {
    const [main, branch] = [page(390, 844, 3, false), page(390, 844, 3, true)];
    const ignore = {
      main: [{ x: 10.5, y: 60, width: 200, height: 300 }],
      branch: [{ x: 0, y: 0, width: 5, height: 5 }],
    };
    expectSame(diff, [main, branch], {}, ignore);
    expectSame(diff, [main, branch], { threshold: 0, mergeDistance: 0, minRegionArea: 1 });
    expectSame(diff, [main, branch], { threshold: 0.2, mergeDistance: 60, noiseAmplitude: 0 });
    expect(reasons).toEqual([]);
  });

  test("shots of different sizes diff the overlap only", () => {
    expectSame(diff, [page(390, 844, 5, false), page(420, 700, 5, true)]);
    expectSame(diff, [page(420, 700, 5, true), page(390, 844, 5, false)]);
    expect(reasons).toEqual([]);
  });

  test("RGB, translucent pixels and every filter type", () => {
    const rgba = PNG.sync.read(page(200, 120, 9, true));
    for (let i = 3; i < rgba.data.length; i += 4 * 7) rgba.data[i] = (i * 13) & 0xff;
    const main = PNG.sync.write(PNG.sync.read(page(200, 120, 9, false)), { colorType: 2 });
    for (const filterType of [0, 1, 2, 3, 4, -1]) {
      expectSame(diff, [main, PNG.sync.write(rgba, { filterType })]);
    }
    expect(reasons).toEqual([]);
  });

  test("narrow and odd widths: the wasm filter's first pixel, its 16-byte steps and its tail", () => {
    let seed = 7;
    const noise = (width: number, height: number) => {
      const png = new PNG({ width, height });
      for (let i = 0; i < png.data.length; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        png.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
      }
      return PNG.sync.write(png);
    };
    for (const width of [1, 2, 3, 4, 5, 7, 8, 9, 13, 33]) {
      expectSame(diff, [noise(width, 5), noise(width, 5)]);
    }
    expect(reasons).toEqual([]);
  });
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

describe("wasmDiffer reads what it can and hands the rest to diffPngs", () => {
  const other = PNG.sync.write(Object.assign(new PNG({ width: 4, height: 3 }), {}));

  test("split IDAT, gAMA and an unknown ancillary chunk stay on the fast path", () => {
    const { diff, reasons } = fastOnly();
    const gama = Buffer.alloc(4);
    gama.writeUInt32BE(45455);
    expectSame(diff, [handMade([chunk("gAMA", gama), chunk("teXt", Buffer.from("a\0b"))]), other]);
    expect(reasons).toEqual([]);
  });

  test("tRNS, interlace and 16-bit fall back, with the same answer", () => {
    const { diff, reasons } = fastOnly();
    const big = PNG.sync.write(PNG.sync.read(page(40, 30, 1, true)), { bitDepth: 16 });
    expectSame(diff, [page(40, 30, 1, false), big]);
    expectSame(diff, [handMade([chunk("tRNS", Buffer.alloc(6))]), other]);
    expect(reasons).toHaveLength(2);
  });

  test("a broken PNG fails as diffPngs fails", () => {
    const { diff } = fastOnly();
    const broken = handMade([]);
    broken.writeUInt8(broken.readUInt8(broken.length - 20) ^ 0xff, broken.length - 20);
    expect(() => diffPngs(broken, other)).toThrow("unrecognised content at end of stream");
    expect(() => diff(broken, other)).toThrow("unrecognised content at end of stream");
  });
});
