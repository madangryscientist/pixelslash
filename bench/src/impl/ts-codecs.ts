/**
 * The PNG decoders and overlay encoders the TS impl can run (PS-168), behind `--decoder` and
 * `--overlay`. A decoder returns 8-bit RGBA, not premultiplied, with no colour or gamma conversion:
 * the bytes pngjs gives, which a test holds on every corpus PNG. One that cannot give them for a
 * file (16-bit, palette, grey) throws rather than guessing. Only pngjs splits its decode into phases
 * (`ts-decode.ts`); the others are one `other` span.
 *
 * Licences and where each runs are in `CODECS`, which the decoder table (`bench:decoders`) prints.
 *
 * Each library is imported when it is first asked for, so a run pays the load of its own codec only.
 */
import { PNG } from "pngjs";
import type { Raster } from "@pixelslash/engine";

export const DECODERS = [
  "pngjs",
  "fast-png",
  "upng",
  "sharp",
  "napi-image",
  "jsquash",
  "cf-wasm",
] as const;
export type DecoderName = (typeof DECODERS)[number];

export const OVERLAYS = [
  "none",
  "pngjs",
  "pngjs-l6",
  "pngjs-l1",
  "sharp",
  "napi-image",
  "cf-wasm",
] as const;
export type OverlayName = (typeof OVERLAYS)[number];

export type Codec = {
  licence: string;
  /** Can it load in Cloudflare's workerd (WASM or JS only, no native addon)? */
  workerd: boolean;
  /** Can the CLI (Bun) load it? */
  cli: boolean;
  /** The npm packages whose installed size is its install weight. */
  packages: string[];
  /** Why it is not shippable, when it is not. */
  never?: string;
};

export const CODECS: Record<DecoderName, Codec> = {
  pngjs: { licence: "MIT", workerd: true, cli: true, packages: ["pngjs"] },
  "fast-png": {
    licence: "MIT",
    workerd: true,
    cli: true,
    packages: ["fast-png", "pako", "iobuffer"],
  },
  upng: { licence: "MIT", workerd: true, cli: true, packages: ["upng-js", "pako"] },
  sharp: {
    licence: "Apache-2.0 (libvips LGPL-3.0, dynamically linked)",
    workerd: false,
    cli: true,
    packages: ["sharp", "@img"],
    never: "libvips is LGPL-3.0",
  },
  "napi-image": {
    licence: "MIT",
    workerd: false,
    cli: true,
    packages: ["@napi-rs/image", "@napi-rs/image-linux-x64-gnu"],
  },
  jsquash: { licence: "Apache-2.0", workerd: true, cli: true, packages: ["@jsquash/png"] },
  "cf-wasm": { licence: "MIT", workerd: true, cli: true, packages: ["@cf-wasm/png"] },
};

type Shape = { width: number; height: number; channels: number };

function rgba(pixels: Uint8Array, { width, height, channels }: Shape, who: string): Raster {
  const data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (channels === 4 && data.length === width * height * 4) return { data, width, height };
  if (channels !== 3 || data.length !== width * height * 3)
    throw new Error(`${who}: only 8-bit RGB and RGBA are compared, got ${channels} channels`);
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    out[o] = data[i] ?? 0;
    out[o + 1] = data[i + 1] ?? 0;
    out[o + 2] = data[i + 2] ?? 0;
    out[o + 3] = 255;
  }
  return { data: out, width, height };
}

/** The file's bytes as an ArrayBuffer of their own: no copy when the Buffer is not a slice of a pool. */
function arrayBuffer(file: Buffer): ArrayBuffer {
  const { buffer } = file;
  if (
    buffer instanceof ArrayBuffer &&
    file.byteOffset === 0 &&
    file.byteLength === buffer.byteLength
  )
    return buffer;
  return new Uint8Array(file).buffer;
}

const DECODE: Record<DecoderName, (file: Buffer) => Promise<Raster>> = {
  pngjs: async (file) => {
    const png = PNG.sync.read(file);
    return { data: png.data, width: png.width, height: png.height };
  },
  "fast-png": async (file) => {
    const { decode } = await import("fast-png");
    const png = decode(file);
    if (png.depth !== 8 || png.palette || !(png.data instanceof Uint8Array))
      throw new Error("fast-png: only 8-bit RGB and RGBA are compared");
    return rgba(png.data, png, "fast-png");
  },
  upng: async (file) => {
    const { default: UPNG } = await import("upng-js");
    const png = UPNG.decode(arrayBuffer(file));
    const [frame] = UPNG.toRGBA8(png);
    if (!frame) throw new Error("upng: no frame");
    return rgba(
      new Uint8Array(frame),
      { width: png.width, height: png.height, channels: 4 },
      "upng",
    );
  },
  sharp: async (file) => {
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return rgba(data, info, "sharp");
  },
  "napi-image": async (file) => {
    const { Transformer } = await import("@napi-rs/image");
    const image = new Transformer(file);
    const { width, height } = image.metadataSync();
    const pixels = image.rawPixelsSync();
    return rgba(
      pixels,
      { width, height, channels: pixels.length / (width * height) },
      "napi-image",
    );
  },
  jsquash: async (file) => {
    const { decode } = await import("@jsquash/png");
    const image = await decode(arrayBuffer(file));
    const shape = { width: image.width, height: image.height, channels: 4 };
    return rgba(new Uint8Array(image.data.buffer), shape, "jsquash");
  },
  "cf-wasm": async (file) => {
    const { decode } = await import("@cf-wasm/png/node");
    const png = decode(file);
    if (png.bitDepth !== 8) throw new Error("cf-wasm: only 8-bit RGB and RGBA are compared");
    const shape = { width: png.width, height: png.height, channels: png.lineSize / png.width };
    return rgba(png.image, shape, "cf-wasm");
  },
};

/** Decode one PNG's bytes with `name`. pngjs is the baseline the others are held to. */
export function decodeWith(name: DecoderName, file: Buffer): Promise<Raster> {
  return DECODE[name](file);
}

function pngjsWrite({ data, width, height }: Raster, deflateLevel?: number): Buffer {
  const png = Object.assign(new PNG({ width, height }), { data });
  return deflateLevel === undefined ? PNG.sync.write(png) : PNG.sync.write(png, { deflateLevel });
}

const ENCODE: Record<OverlayName, (overlay: Raster) => Promise<Buffer>> = {
  none: async () => Buffer.alloc(0),
  pngjs: async (overlay) => pngjsWrite(overlay),
  "pngjs-l6": async (overlay) => pngjsWrite(overlay, 6),
  "pngjs-l1": async (overlay) => pngjsWrite(overlay, 1),
  sharp: async ({ data, width, height }) => {
    const { default: sharp } = await import("sharp");
    return sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  },
  "napi-image": async ({ data, width, height }) => {
    const { Transformer } = await import("@napi-rs/image");
    return Transformer.fromRgbaPixels(data, width, height).pngSync();
  },
  "cf-wasm": async ({ data, width, height }) => {
    const { encode } = await import("@cf-wasm/png/node");
    return Buffer.from(encode(data, width, height));
  },
};

/** Encode the overlay with `name`; `none` encodes nothing (the bench default: the contract never reads it). */
export function encodeWith(name: OverlayName, overlay: Raster): Promise<Buffer> {
  return ENCODE[name](overlay);
}

export function isDecoder(name: string): name is DecoderName {
  return DECODERS.some((d) => d === name);
}

export function isOverlay(name: string): name is OverlayName {
  return OVERLAYS.some((o) => o === name);
}
