/**
 * The PNGs behind the dogfood seed (dogfood-seed.ts): the build and snapshot pages show real
 * pictures, and a missing one is a 404 the capture would never settle past. Generated, so the
 * bytes are the same every run, and encoded here so no dependency is added for it.
 */
import { crc32, deflateSync } from "node:zlib";

export const WIDTH = 640;
export const HEIGHT = 400;
/** The block a changed shot moved between Main and Branch; the seeded diff region is this box. */
export const CHANGE = { x: 360, y: 120, w: 200, h: 120 };

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function encode(rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const at = y * (WIDTH * 3 + 1);
    for (let x = 0; x < WIDTH; x++) rows.set(rgb(x, y), at + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A page-like picture: a tinted backdrop, a header bar and a card. `moved` shifts the card's colour. */
export function seedPng(index: number, moved: boolean): Buffer {
  const tint = (index * 37) % 255;
  return encode((x, y) => {
    if (y < 48) return [30, 41, 59];
    const inCard =
      x >= CHANGE.x && x < CHANGE.x + CHANGE.w && y >= CHANGE.y && y < CHANGE.y + CHANGE.h;
    if (inCard) return moved ? [239, 68, 68] : [59, 130, 246];
    return [235 - (y >> 4), 240 - (x >> 5), 245 - (tint >> 3)];
  });
}
