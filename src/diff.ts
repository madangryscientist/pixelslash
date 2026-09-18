import { PNG } from "pngjs";

export type PixelDiff = {
  changedPixels: number;
  overlay: Buffer;
  width: number;
  height: number;
};

function fillMagenta(img: PNG): void {
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    img.data[o] = 255;
    img.data[o + 1] = 0;
    img.data[o + 2] = 255;
    img.data[o + 3] = 255;
  }
}

export function diffPngs(main: Buffer, branch: Buffer): PixelDiff {
  const a = PNG.sync.read(main);
  const b = PNG.sync.read(branch);
  if (a.width !== b.width || a.height !== b.height) {
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const overlay = new PNG({ width, height });
    fillMagenta(overlay);
    return { changedPixels: width * height, overlay: PNG.sync.write(overlay), width, height };
  }
  const overlay = new PNG({ width: a.width, height: a.height });
  let changedPixels = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    const same =
      a.data[o] === b.data[o] &&
      a.data[o + 1] === b.data[o + 1] &&
      a.data[o + 2] === b.data[o + 2] &&
      a.data[o + 3] === b.data[o + 3];
    if (same) {
      overlay.data[o] = 0;
      overlay.data[o + 1] = 0;
      overlay.data[o + 2] = 0;
      overlay.data[o + 3] = 0;
    } else {
      changedPixels++;
      overlay.data[o] = 255;
      overlay.data[o + 1] = 0;
      overlay.data[o + 2] = 255;
      overlay.data[o + 3] = 255;
    }
  }
  return { changedPixels, overlay: PNG.sync.write(overlay), width: a.width, height: a.height };
}
