/**
 * The PNG pairs the perf steps time (ob 1790): generated, deterministic and written once per run by
 * the runner, so the base tree and the head tree diff and upload the very same bytes. A page is a
 * header, then cards of a title stripe, text stripes and a button; the head variant recolours some
 * buttons and nudges a card, which is what a real change looks like to the diff.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export const DIFF_SIZES = {
  "diff-phone": { width: 390, height: 844 },
  "diff-desktop": { width: 1440, height: 900 },
  "diff-long": { width: 1440, height: 6000 },
} as const;

export const BUILD_SHOTS = 10;
export const BUILD_SIZE = { width: 800, height: 600 };

type Rgb = [number, number, number];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rect = [x: number, y: number, w: number, h: number];

function fill(png: PNG, [x, y, w, h]: Rect, [r, g, b]: Rgb): void {
  for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx += 1) {
      const at = (yy * png.width + xx) * 4;
      png.data[at] = r;
      png.data[at + 1] = g;
      png.data[at + 2] = b;
      png.data[at + 3] = 255;
    }
  }
}

const CARD_H = 140;

/** `head` recolours every third button and moves every fifth card 3 px right. */
export function page(width: number, height: number, seed: number, head: boolean): Buffer {
  const png = new PNG({ width, height });
  fill(png, [0, 0, width, height], [255, 255, 255]);
  fill(png, [0, 0, width, 56], [31, 41, 55]);
  const rand = mulberry32(seed);
  const cardW = Math.min(width - 32, 640);
  for (let n = 0, y = 72; y + CARD_H < height; n += 1, y += CARD_H + 16) {
    const x = 16 + (head && n % 5 === 4 ? 3 : 0);
    fill(png, [x, y, cardW, CARD_H], [226, 232, 240]);
    fill(png, [x + 1, y + 1, cardW - 2, CARD_H - 2], [248, 250, 252]);
    fill(png, [x + 12, y + 12, Math.round(cardW * (0.3 + rand() * 0.3)), 14], [30, 41, 59]);
    for (let line = 0; line < 4; line += 1) {
      fill(
        png,
        [x + 12, y + 38 + line * 16, Math.round(cardW * (0.4 + rand() * 0.5)), 8],
        [148, 163, 184],
      );
    }
    const button: Rgb = head && n % 3 === 2 ? [220, 38, 38] : [37, 99, 235];
    fill(png, [x + 12, y + CARD_H - 34, 96, 22], button);
  }
  return PNG.sync.write(png);
}

export const mainFile = (name: string): string => `${name}-main.png`;
export const branchFile = (name: string): string => `${name}-branch.png`;
export const buildShotName = (i: number): string => `shot-${String(i).padStart(2, "0")}`;

/** Write every pair under `dir`: three diff sizes and the ten shots of the server build. */
export function writeFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  Object.entries(DIFF_SIZES).forEach(([name, { width, height }], i) => {
    writeFileSync(join(dir, mainFile(name)), page(width, height, 100 + i, false));
    writeFileSync(join(dir, branchFile(name)), page(width, height, 100 + i, true));
  });
  for (let i = 0; i < BUILD_SHOTS; i += 1) {
    const { width, height } = BUILD_SIZE;
    const name = buildShotName(i);
    writeFileSync(join(dir, mainFile(name)), page(width, height, 200 + i, false));
    // Four shots change, six stay as they were: a typical build is mostly unchanged.
    writeFileSync(join(dir, branchFile(name)), page(width, height, 200 + i, i % 5 < 2));
  }
}
