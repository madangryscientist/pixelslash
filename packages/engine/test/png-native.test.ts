import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { measurePngs } from "../src/diff.ts";
import { pngjsCodec, setPngCodec } from "../src/png-codec.ts";
import { nativeCodec, nativeDecodable, useNativePngCodec } from "../src/png-native.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Every PNG the bench decodes: both corpora and the DS fixtures. */
function corpusPngs(): string[] {
  return ["bench/corpus", "bench/corpus-holdout", "fixtures/ds"].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".png"))
      .map((f) => join(ROOT, dir, f)),
  );
}

function hash(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

let loaded = false;
beforeAll(async () => {
  loaded = await useNativePngCodec();
});
// useNativePngCodec installs the codec for the process; the other files in this worker get pngjs back.
afterAll(() => setPngCodec(pngjsCodec));

describe("the CLI's native PNG decode (PS-185)", () => {
  const files = corpusPngs();

  test("the corpus is there, and the addon loaded", () => {
    expect(loaded).toBe(true);
    expect(files.length).toBeGreaterThan(300);
  });

  test("gives pngjs's RGBA on every corpus PNG", () => {
    let native = 0;
    for (const file of files) {
      const bytes = readFileSync(file);
      const want = pngjsCodec.decode(bytes);
      const got = nativeCodec.decode(bytes);
      expect(`${file} ${got.width}x${got.height} ${hash(got.data)}`).toBe(
        `${file} ${want.width}x${want.height} ${hash(want.data)}`,
      );
      if (nativeDecodable(bytes)) native++;
    }
    // The corpus is mostly what the native path takes; a header check that refused all of it
    // would pass the equality above while measuring nothing.
    expect(native).toBeGreaterThan(files.length * 0.9);
  }, 120_000);
});

describe("what falls back to pngjs (PS-185)", () => {
  const rgba = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < rgba.data.length; i++) rgba.data[i] = (i * 37) & 255;

  test("8-bit RGBA and RGB are native", () => {
    expect(nativeDecodable(PNG.sync.write(rgba))).toBe(true);
    expect(nativeDecodable(PNG.sync.write(rgba, { colorType: 2, inputHasAlpha: true }))).toBe(true);
  });

  test("grey and 16-bit files are not, and still decode as pngjs does", () => {
    for (const options of [{ colorType: 0 as const }, { bitDepth: 16 as const }]) {
      const bytes = PNG.sync.write(rgba, options);
      expect(nativeDecodable(bytes)).toBe(false);
      expect(hash(nativeCodec.decode(bytes).data)).toBe(hash(pngjsCodec.decode(bytes).data));
    }
  });

  test("a tRNS chunk, which makes RGB pixels transparent, is not native", () => {
    const base = PNG.sync.write(rgba, { colorType: 2, inputHasAlpha: true });
    const trns = Buffer.alloc(12 + 6);
    trns.writeUInt32BE(6, 0);
    trns.write("tRNS", 4, "latin1");
    const withTrns = Buffer.concat([base.subarray(0, 33), trns, base.subarray(33)]);
    expect(nativeDecodable(withTrns)).toBe(false);
  });

  test("bytes that are not a PNG are not native, and pngjs reports them", () => {
    expect(nativeDecodable(Buffer.from("not a png"))).toBe(false);
    expect(() => nativeCodec.decode(Buffer.from("not a png"))).toThrow(/./);
  });
});

describe("the diff through the native codec (PS-185)", () => {
  const pairs = [
    ["bench/corpus", 4],
    ["bench/corpus-holdout", 4],
  ] as const;

  /** The same diff with each codec: the result is equal, and the overlays decode to the same pixels. */
  test("measurePngs gives the same result and the same overlay pixels as pngjs", () => {
    for (const [dir, limit] of pairs) {
      const files = readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".png"))
        .toSorted();
      const bytes = files.slice(0, limit * 2).map((f) => readFileSync(join(ROOT, dir, f)));
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const [a, b] = [bytes[i], bytes[i + 1]];
        if (!a || !b) continue;
        const native = measurePngs(a, b);
        setPngCodec(pngjsCodec);
        const plain = measurePngs(a, b);
        setPngCodec(nativeCodec);
        const { overlay: nativeOverlay, ...nativeRest } = native;
        const { overlay: plainOverlay, ...plainRest } = plain;
        expect(nativeRest).toEqual(plainRest);
        const got = pngjsCodec.decode(nativeOverlay);
        const want = pngjsCodec.decode(plainOverlay);
        expect([got.width, got.height]).toEqual([want.width, want.height]);
        expect(hash(got.data)).toBe(hash(want.data));
      }
    }
  }, 120_000);
});
