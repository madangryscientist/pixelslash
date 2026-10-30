/** The burst's shots (PS-214): busy PNGs at the corpus sizes, and the multipart body the CLI sends. */
import { type Block, png } from "../e2e/png";

/** PERF.md's phone, desktop and long pages, and HC-124's 1280x9500 long page. */
function sizesOf(mix: string): [number, number][] {
  if (mix !== "mixed") return [[Number(mix.split("x")[0]), Number(mix.split("x")[1])]];
  return [
    [1280, 9500],
    [1280, 9500],
    [1440, 6000],
    [1440, 6000],
    [1440, 6000],
    [1440, 900],
    [1440, 900],
    [1440, 900],
    [390, 844],
    [390, 844],
  ];
}

function block(n: number, at: number): Block {
  return { x: 40 + n * 90, y: at, w: 60, h: 400, rgb: [220, 30 + n * 20, 30] };
}

export type Shot = { name: string; viewport: string; png: Buffer };

/** `count` shots cycling the sizes, three busy PNGs per size (as the e2e burst does). */
export function shots(mix: string, count: number, blockAt: number): Shot[] {
  const sizes = sizesOf(mix);
  const pool = sizes.map(([w, h]) => [0, 1, 2].map((n) => png(w, h, [block(n, blockAt)], n)));
  return Array.from({ length: count }, (_, i) => {
    const size = i % sizes.length;
    const [w, h] = sizes[size] ?? [0, 0];
    return {
      name: `page-${i}`,
      viewport: `${w}x${h}`,
      png: pool[size]?.[Math.floor(i / sizes.length) % 3] ?? Buffer.alloc(0),
    };
  });
}

export function form(shot: Shot): FormData {
  const f = new FormData();
  f.set(
    "meta",
    JSON.stringify({
      name: shot.name,
      platform: "linux",
      browser: "chromium",
      viewport: shot.viewport,
      theme: "light",
      tags: ["web"],
      fingerprint: { image: "version:perf", browser: "chromium 1", fonts: "sha256:f" },
    }),
  );
  f.set("file", new Blob([new Uint8Array(shot.png)], { type: "image/png" }), "shot.png");
  return f;
}
