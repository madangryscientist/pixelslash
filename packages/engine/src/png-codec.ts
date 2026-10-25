import { PNG } from "pngjs";
import type { Raster } from "./diff-probe.ts";

/** Decode a PNG to 8-bit RGBA, and write RGBA as a PNG. The diff's only two PNG calls. */
export type PngCodec = {
  decode(bytes: Buffer): Raster;
  encode(raster: Raster): Buffer;
};

/** pngjs: pure JS, so it runs everywhere, workerd included. The default, and the fallback. */
export const pngjsCodec: PngCodec = {
  decode: (bytes) => PNG.sync.read(bytes),
  encode: ({ data, width, height }) => {
    const png = new PNG({});
    png.width = width;
    png.height = height;
    png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return PNG.sync.write(png);
  },
};

let active: PngCodec = pngjsCodec;

/** Swap the codec the diff uses (the CLI installs the native one, `png-native.ts`). */
export function setPngCodec(codec: PngCodec): void {
  active = codec;
}

export const decodePng = (bytes: Buffer): Raster => active.decode(bytes);
export const encodePng = (raster: Raster): Buffer => active.encode(raster);
