#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

const ROOT = join(import.meta.dir, "..");

function fill(img: PNG, x0: number, y0: number, w: number, h: number, rgba: [number, number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) << 2;
      img.data[i] = rgba[0];
      img.data[i + 1] = rgba[1];
      img.data[i + 2] = rgba[2];
      img.data[i + 3] = rgba[3];
    }
  }
}

function write(path: string, img: PNG): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(img));
}

const button = new PNG({ width: 120, height: 40 });
fill(button, 0, 0, 120, 40, [0xf4, 0xf4, 0xf5, 255]);
fill(button, 8, 8, 104, 24, [0x25, 0x63, 0xeb, 255]);
write(join(ROOT, "fixtures/ds/button.png"), button);

const card = new PNG({ width: 160, height: 80 });
fill(card, 0, 0, 160, 80, [0xf4, 0xf4, 0xf5, 255]);
fill(card, 8, 8, 144, 64, [0xd4, 0xd4, 0xd8, 255]);
fill(card, 10, 10, 140, 60, [0xff, 0xff, 0xff, 255]);
write(join(ROOT, "fixtures/ds/card.png"), card);

const heading = new PNG({ width: 160, height: 36 });
fill(heading, 0, 0, 160, 36, [0xf4, 0xf4, 0xf5, 255]);
fill(heading, 0, 8, 96, 16, [0x11, 0x11, 0x11, 255]);
write(join(ROOT, "fixtures/ds/heading.png"), heading);
