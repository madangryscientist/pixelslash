import { PNG } from "pngjs";

/**
 * The PNGs the server-diff tests upload. Tests only: solid shots with painted blocks are enough
 * to tell `changed` from `unchanged` without dragging a browser or the bench corpus in.
 */

export type Block = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGB, alpha is always opaque white-backed. */
  rgb: [number, number, number];
};

export type ShotSpec = {
  width?: number;
  height?: number;
  /** The flat field every shot starts as; white unless a test needs a mid grey to wobble around. */
  base?: [number, number, number];
  blocks?: Block[];
  /** A patch of faint, uneven, two-way colour noise: the engine should call it noise, not change. */
  noise?: Block;
};

export const WHITE: [number, number, number] = [255, 255, 255];
export const RED: [number, number, number] = [220, 30, 30];

function paint(png: PNG, block: Block) {
  for (let y = block.y; y < block.y + block.h; y++) {
    for (let x = block.x; x < block.x + block.w; x++) {
      const at = (y * png.width + x) << 2;
      png.data[at] = block.rgb[0];
      png.data[at + 1] = block.rgb[1];
      png.data[at + 2] = block.rgb[2];
      png.data[at + 3] = 255;
    }
  }
}

/** Deterministic pseudo-random values in [-1, 1]: the same shot on every run and every machine. */
function wobble(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function speckle(png: PNG, block: Block, base: [number, number, number]) {
  let n = 0;
  for (let y = block.y; y < block.y + block.h; y++) {
    for (let x = block.x; x < block.x + block.w; x++) {
      const at = (y * png.width + x) << 2;
      // Faint (well under the noise floor), uneven, and moving both lighter and darker.
      const delta = Math.round(wobble(++n) * 14);
      png.data[at] = base[0] + delta;
      png.data[at + 1] = base[1] + delta;
      png.data[at + 2] = base[2] + delta;
      png.data[at + 3] = 255;
    }
  }
}

function blank(spec: ShotSpec): PNG {
  const base = spec.base ?? WHITE;
  const png = new PNG({ width: spec.width ?? 64, height: spec.height ?? 48 });
  for (let at = 0; at < png.data.length; at += 4) {
    png.data[at] = base[0];
    png.data[at + 1] = base[1];
    png.data[at + 2] = base[2];
    png.data[at + 3] = 255;
  }
  for (const block of spec.blocks ?? []) paint(png, block);
  if (spec.noise) speckle(png, spec.noise, base);
  return png;
}

/** A shot as PNG bytes, so it can be uploaded as a snapshot. */
export function shot(spec: ShotSpec = {}): Uint8Array<ArrayBuffer> {
  return new Uint8Array(PNG.sync.write(blank(spec)));
}
