/**
 * The overlay encoders PS-168 measured for the TS impl; `--overlay` picks one. PS-168's decoders
 * went with PS-210: the TS impl decodes inside `diff.wasm`, and their numbers stay in `PERF.md`.
 *
 * Licences and where each library runs are in `CODECS`, which the decoder table (`bench:decoders`)
 * prints for the overlay rows.
 *
 * Each library is imported when it is first asked for, so a run pays the load of its own codec only.
 */
import { PNG } from "pngjs";
import type { Raster } from "@pixelslash/engine";

/** The libraries behind the encoders; each `pngjs-l*` level is pngjs. */
const LIBRARIES = ["pngjs", "sharp", "napi-image", "cf-wasm"] as const;
type Library = (typeof LIBRARIES)[number];

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

export const CODECS: Record<Library, Codec> = {
  pngjs: { licence: "MIT", workerd: true, cli: true, packages: ["pngjs"] },
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
  "cf-wasm": { licence: "MIT", workerd: true, cli: true, packages: ["@cf-wasm/png"] },
};

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

export function isLibrary(name: string): name is Library {
  return LIBRARIES.some((l) => l === name);
}

export function isOverlay(name: string): name is OverlayName {
  return OVERLAYS.some((o) => o === name);
}
