import type { PixelDiff } from "./diff.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its IHDR, or null when the bytes do not start like a PNG with a real size. */
export function readPngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || !Buffer.from(png.subarray(0, 8)).equals(PNG_SIGNATURE)) return null;
  if (Buffer.from(png.subarray(12, 16)).toString("latin1") !== "IHDR") return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Identical bytes are identical pixels, so no option or ignore area can change the verdict: the
 * answer is unchanged, without a decode, a comparison or an overlay. Null when the bytes are not
 * the same, or are not a PNG at all (the full path then refuses them as it always did).
 */
export function identicalBytes(main: Buffer, branch: Buffer): PixelDiff | null {
  if (!main.equals(branch)) return null;
  const size = readPngSize(main);
  return size && identicalResult(size);
}

/**
 * The result for two shots known to be the same bytes of this size. The server knows it from the
 * uploads' hashes without reading either (ob 1948).
 */
export function identicalResult(size: { width: number; height: number }): PixelDiff {
  return {
    changed: false,
    ignoredPixels: 0,
    ignored: [],
    changedPixels: 0,
    antialiased: 0,
    regions: [],
    specks: { count: 0, pixels: 0 },
    settledBy: "identical-bytes",
    overlay: null,
    width: size.width,
    height: size.height,
    mainWidth: size.width,
    mainHeight: size.height,
    branchWidth: size.width,
    branchHeight: size.height,
  };
}
