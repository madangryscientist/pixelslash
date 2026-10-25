/**
 * The CLI's PNG codec (PS-185): @napi-rs/image (MIT, a native addon) in place of pngjs. It lives
 * apart from `png-codec.ts` and only the CLI imports it, so a workerd bundle never reaches the
 * addon: the hosted app keeps pngjs.
 *
 * The decode must give pngjs's bytes, so native is used only for what a test holds equal on the
 * corpus (8-bit, non-interlaced RGB or RGBA, no tRNS); any other file, and any native error, goes
 * to pngjs.
 */
import type { Transformer as TransformerClass } from "@napi-rs/image";
import { pngjsCodec, setPngCodec, type PngCodec } from "./png-codec.ts";

/** Set by `useNativePngCodec` once the addon has loaded. */
let Transformer: typeof TransformerClass;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the IHDR says 8-bit, non-interlaced, RGB or RGBA. */
function plainHeader(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return false;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return false;
  const colourType = bytes[25];
  return bytes[24] === 8 && (colourType === 2 || colourType === 6) && bytes[28] === 0;
}

/** True when a plain header is not followed by a tRNS chunk (which makes RGB pixels transparent) before the pixels. */
export function nativeDecodable(bytes: Buffer): boolean {
  if (!plainHeader(bytes)) return false;
  for (let at = 33; at + 8 <= bytes.length;) {
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "tRNS") return false;
    if (type === "IDAT" || type === "IEND") return true;
    at += 12 + bytes.readUInt32BE(at);
  }
  return false;
}

export const nativeCodec: PngCodec = {
  decode(bytes) {
    if (!nativeDecodable(bytes)) return pngjsCodec.decode(bytes);
    try {
      const image = new Transformer(bytes);
      const { width, height } = image.metadataSync();
      const pixels = image.rawPixelsSync();
      const data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      if (data.length === width * height * 4) return { data, width, height };
      if (data.length !== width * height * 3) return pngjsCodec.decode(bytes);
      const rgba = Buffer.allocUnsafe(width * height * 4);
      for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
        rgba[o] = data[i] ?? 0;
        rgba[o + 1] = data[i + 1] ?? 0;
        rgba[o + 2] = data[i + 2] ?? 0;
        rgba[o + 3] = 255;
      }
      return { data: rgba, width, height };
    } catch {
      return pngjsCodec.decode(bytes);
    }
  },
  encode({ data, width, height }) {
    try {
      return Transformer.fromRgbaPixels(data, width, height).pngSync();
    } catch {
      return pngjsCodec.encode({ data, width, height });
    }
  },
};

/**
 * Make the diff decode and encode natively; false (and pngjs stays) when the addon will not load
 * here, as on a platform it ships no binary for. Call once at start-up of a process that runs on Bun.
 */
export async function useNativePngCodec(): Promise<boolean> {
  try {
    ({ Transformer } = await import("@napi-rs/image"));
  } catch {
    return false;
  }
  setPngCodec(nativeCodec);
  return true;
}
