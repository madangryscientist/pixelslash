#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

const ROOT = join(import.meta.dir, "..");

type Rect = { x: number; y: number; w: number; h: number };

function fill(img: PNG, rect: Rect, rgba: [number, number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
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
fill(button, { x: 0, y: 0, w: 120, h: 40 }, [0xf4, 0xf4, 0xf5, 255]);
fill(button, { x: 8, y: 8, w: 104, h: 24 }, [0x25, 0x63, 0xeb, 255]);
write(join(ROOT, "fixtures/ds/button.png"), button);

const card = new PNG({ width: 160, height: 80 });
fill(card, { x: 0, y: 0, w: 160, h: 80 }, [0xf4, 0xf4, 0xf5, 255]);
fill(card, { x: 8, y: 8, w: 144, h: 64 }, [0xd4, 0xd4, 0xd8, 255]);
fill(card, { x: 10, y: 10, w: 140, h: 60 }, [0xff, 0xff, 0xff, 255]);
write(join(ROOT, "fixtures/ds/card.png"), card);

const heading = new PNG({ width: 160, height: 36 });
fill(heading, { x: 0, y: 0, w: 160, h: 36 }, [0xf4, 0xf4, 0xf5, 255]);
fill(heading, { x: 0, y: 8, w: 96, h: 16 }, [0x11, 0x11, 0x11, 255]);
write(join(ROOT, "fixtures/ds/heading.png"), heading);
