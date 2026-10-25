import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { diffPngs, diffRasters } from "../src/diff.ts";
import { decodePng } from "../src/png-codec.ts";
import { release } from "../src/release.ts";

/** A 700x700 (2 MB decoded) busy page; `block` paints a solid red square on it. */
function page(block: boolean): Buffer {
  const img = new PNG({ width: 700, height: 700 });
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.imul(i >> 2, 2654435761) >>> 24;
    const [x, y] = [(i >> 2) % 700, Math.floor(i / 4 / 700)];
    const red = block && x >= 100 && x < 300 && y >= 100 && y < 300;
    img.data[i] = red ? 255 : v;
    img.data[i + 1] = red ? 0 : 255 - v;
    img.data[i + 2] = red ? 0 : 40;
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

describe("release", () => {
  test("detaches a large buffer's store and frees its bytes", () => {
    const bytes = Buffer.alloc(4 << 20, 7);
    const store = bytes.buffer;
    release(bytes);
    expect(store.detached).toBe(true);
    expect(bytes.byteLength).toBe(0);
  });

  test("leaves a small buffer, and a view onto part of a store, alone", () => {
    const small = Buffer.alloc(1024, 1);
    release(small);
    expect(small.byteLength).toBe(1024);

    const whole = new Uint8Array(4 << 20);
    const view = whole.subarray(16);
    release(view);
    expect(whole.byteLength).toBe(4 << 20);
    expect(view.byteLength).toBe((4 << 20) - 16);
  });

  test("does not throw on a store it cannot detach", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(2 << 20));
    expect(() => release(shared)).not.toThrow();
  });
});

describe("diffPngs frees its own rasters without changing the result", () => {
  test("the result is the one the same diff gives from rasters that are kept", () => {
    const main = page(false);
    const branch = page(true);
    const freed = diffPngs(main, branch);
    const kept = diffRasters(decodePng(main), decodePng(branch));
    expect(freed.changed).toBe(true);
    expect(Buffer.compare(freed.overlay ?? Buffer.alloc(0), kept.overlay)).toBe(0);
    expect(freed.changedPixels).toBe(kept.changedPixels);
    expect(freed.regions).toEqual(kept.regions);
  });

  test("a caller's own encode keeps the overlay it was handed", () => {
    const kept: Uint8Array[] = [];
    const capture = ({ data }: { data: Uint8Array }) => {
      kept.push(data);
      return Buffer.alloc(0);
    };
    diffRasters(decodePng(page(false)), decodePng(page(true)), {}, { encode: capture });
    expect(kept[0]?.byteLength).toBe(700 * 700 * 4);
  });
});
