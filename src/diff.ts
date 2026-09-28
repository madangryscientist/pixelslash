import { PNG } from "pngjs";

export type PixelDiff = {
  changedPixels: number;
  overlay: Buffer;
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
};

export function diffPngs(main: Buffer, branch: Buffer): PixelDiff {
  const a = PNG.sync.read(main);
  const b = PNG.sync.read(branch);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const overlapW = Math.min(a.width, b.width);
  const overlapH = Math.min(a.height, b.height);
  const overlay = new PNG({ width, height });
  let changedPixels = 0;
  for (let y = 0; y < overlapH; y++) {
    for (let x = 0; x < overlapW; x++) {
      const ia = (y * a.width + x) << 2;
      const ib = (y * b.width + x) << 2;
      const io = (y * width + x) << 2;
      const same =
        a.data[ia] === b.data[ib] &&
        a.data[ia + 1] === b.data[ib + 1] &&
        a.data[ia + 2] === b.data[ib + 2] &&
        a.data[ia + 3] === b.data[ib + 3];
      if (same) continue;
      changedPixels++;
      overlay.data[io] = 255;
      overlay.data[io + 1] = 0;
      overlay.data[io + 2] = 255;
      overlay.data[io + 3] = 255;
    }
  }
  return {
    changedPixels,
    overlay: PNG.sync.write(overlay),
    width,
    height,
    mainWidth: a.width,
    mainHeight: a.height,
    branchWidth: b.width,
    branchHeight: b.height,
  };
}
