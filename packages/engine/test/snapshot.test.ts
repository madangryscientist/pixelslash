import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import {
  captureSnapshots,
  paintRects,
  toImageRects,
  type SnapshotManifest,
} from "../src/snapshot.ts";

const SITE = fileURLToPath(new URL("../../../fixtures/capture/site", import.meta.url));
const dirs: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(SITE, `${path === "/" ? "index" : path.slice(1)}.html`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": "text/html" } });
  },
});
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-snap-"));
  dirs.push(dir);
  return dir;
}

const config = parseConfig({
  baseUrl: `http://127.0.0.1:${server.port}`,
  routes: [
    "/",
    "/motion",
    { path: "/masks", masks: [".ad", { x: 0, y: 200, width: 320, height: 40 }] },
  ],
  diff: { threshold: 0.1 },
  variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
  tags: ["fixture"],
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

function pixel(img: PNG, x: number, y: number): number[] {
  const o = (y * img.width + x) << 2;
  return Array.from(img.data.subarray(o, o + 4));
}

/** One route captured alone, with page timers frozen or running; the PNG bytes. */
async function shootPage(path: string, timers: boolean): Promise<Buffer> {
  const routes = [
    {
      path,
      name: "page",
      masks: [],
      tags: [],
      ignore: [],
      diff: {},
      variantDiff: {},
      variantIgnore: {},
    },
  ];
  const out = await tmp();
  await captureSnapshots(
    { ...config, routes, stabilise: { ...config.stabilise, timers } },
    out,
    pinned,
  );
  return Buffer.from(await Bun.file(join(out, "page/desktop.png")).bytes());
}

describe("captureSnapshots", () => {
  test("two runs write byte-identical PNGs and the same manifest (motion, caret, clock included)", async () => {
    const [a, b] = [await tmp(), await tmp()];
    const first = await captureSnapshots(config, a, pinned);
    await captureSnapshots(config, b, pinned);
    expect(first.manifest.snapshots.map((s) => s.file)).toEqual([
      "index/desktop.png",
      "motion/desktop.png",
      "masks/desktop.png",
    ]);
    for (const { file } of first.manifest.snapshots) {
      const left = await Bun.file(join(a, file)).bytes();
      const right = await Bun.file(join(b, file)).bytes();
      expect({ file, same: Buffer.compare(left, right) === 0 }).toEqual({ file, same: true });
    }
    const manifest: SnapshotManifest = await Bun.file(join(a, "manifest.json")).json();
    expect(await Bun.file(join(b, "manifest.json")).json()).toEqual(manifest);
    expect(manifest.version).toBe(1);
    const [entry] = manifest.snapshots;
    expect(entry).toMatchObject({
      name: "index",
      path: "/",
      tags: ["fixture"],
      diff: { threshold: 0.1 },
      file: "index/desktop.png",
      variant: {
        name: "desktop",
        browser: "chromium",
        theme: "light",
        viewport: { width: 800, height: 400 },
      },
    });
    expect(entry?.fingerprint.image).toBe("version:test");
    expect(entry?.fingerprint.browser).toMatch(/^chromium \d+\./);
    expect(entry?.fingerprint.fonts).toMatch(/^sha256:/);
    // Selector (.ad) and rectangle masks blank their regions and nothing else.
    const img = PNG.sync.read(Buffer.from(await Bun.file(join(a, "masks/desktop.png")).bytes()));
    const magenta = [255, 0, 255, 255];
    for (const [x, y] of [
      [40, 40],
      [239, 139],
      [300, 40],
      [499, 139],
      [0, 200],
      [319, 239],
    ] as const)
      expect({ x, y, rgba: pixel(img, x, y) }).toEqual({ x, y, rgba: magenta });
    expect(pixel(img, 10, 310)).toEqual([37, 99, 235, 255]);
    expect(pixel(img, 600, 20)).toEqual([255, 255, 255, 255]);
    expect(pixel(img, 0, 241)).toEqual([255, 255, 255, 255]);
  }, 60_000);

  test("a page changing on a 100 ms setInterval captures identically twice, and timers: false lets it run", async () => {
    const [a, b] = [await shootPage("/ticker", true), await shootPage("/ticker", true)];
    expect(Buffer.compare(a, b)).toBe(0);
    // Frozen means the interval never ran: "Ticks: 0" in the shot. Let it run and the count has moved on.
    expect(Buffer.compare(a, await shootPage("/ticker", false))).not.toBe(0);
  }, 60_000);

  test("no page timer fires while the settle runs, however short", async () => {
    const frozen = PNG.sync.read(await shootPage("/early-timers", true));
    expect(pixel(frozen, 700, 300)).toEqual([255, 255, 255, 255]);
    const running = PNG.sync.read(await shootPage("/early-timers", false));
    expect(pixel(running, 700, 300)).toEqual([225, 29, 72, 255]);
  }, 60_000);

  test("outside the image: warns, records a bare fingerprint; a mask matching nothing warns", async () => {
    const warnings: string[] = [];
    const routes = [
      {
        path: "/",
        name: "index",
        masks: [".nope"],
        tags: [],
        ignore: [],
        diff: {},
        variantDiff: {},
        variantIgnore: {},
      },
    ];
    const result = await captureSnapshots({ ...config, routes }, await tmp(), {
      env: {},
      listFonts: async () => [],
      warn: (m) => warnings.push(m),
    });
    expect(result.manifest.snapshots[0]?.fingerprint.image).toBe("bare");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/outside the pinned PixelSlash image/);
    expect(warnings[1]).toBe('warning: mask ".nope" matched no shot in this run');
  }, 60_000);
});

const ignoreConfig = (scale: number, ignore: unknown[], masks: unknown[] = []) =>
  parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [{ path: "/ignore", name: "page", ignore, masks }],
    variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
    stabilise: { deviceScaleFactor: scale },
  });

describe("selectors that match nothing (PS-241)", () => {
  const twoShots = parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [
      { path: "/ignore", name: "page", ignore: [".video", ".nope"], masks: [".nope"] },
      { path: "/", name: "home", ignore: [".video", ".nope"], masks: [".nope"] },
    ],
    variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
  });

  test("a selector that matches some shots is one summary line, not a line per shot", async () => {
    const warnings: string[] = [];
    await captureSnapshots(twoShots, await tmp(), { ...pinned, warn: (m) => warnings.push(m) });
    // One line per selector, for the run: none per shot, and the two shots' misses summed.
    expect(warnings.toSorted()).toEqual([
      'ignore ".video" matched nothing on 1 of 2 shots',
      'warning: ignore ".nope" matched no shot in this run',
      'warning: mask ".nope" matched no shot in this run',
    ]);
  }, 60_000);
});

describe("ignore areas", () => {
  test.each([1, 2])(
    "a selector and the data attribute resolve to image-px boxes at device scale %i, and nothing is painted",
    async (scale) => {
      const out = await tmp();
      const warnings: string[] = [];
      const result = await captureSnapshots(ignoreConfig(scale, [".video", ".nope"]), out, {
        ...pinned,
        warn: (m) => warnings.push(m),
      });
      expect(result.manifest.snapshots[0]?.ignore).toEqual([
        { x: 40 * scale, y: 40 * scale, width: 200 * scale, height: 100 * scale },
        { x: 300 * scale, y: 40 * scale, width: 100 * scale, height: 60 * scale },
      ]);
      expect(warnings).toEqual(['warning: ignore ".nope" matched no shot in this run']);
      const img = PNG.sync.read(Buffer.from(await Bun.file(join(out, "page/desktop.png")).bytes()));
      expect(img.width).toBe(800 * scale);
      // The real pixels are still there: green video, amber marked box.
      expect(pixel(img, 50 * scale, 50 * scale)).toEqual([22, 163, 74, 255]);
      expect(pixel(img, 310 * scale, 50 * scale)).toEqual([245, 158, 11, 255]);
    },
    60_000,
  );

  test("rectangles are CSS px scaled and clipped; a redact mask next to an ignore is still painted", async () => {
    const out = await tmp();
    const result = await captureSnapshots(
      ignoreConfig(
        2,
        [{ x: 700, y: 380, width: 500, height: 500 }],
        [{ x: 0, y: 300, width: 320, height: 40 }],
      ),
      out,
      pinned,
    );
    expect(result.manifest.snapshots[0]?.ignore).toEqual([
      { x: 600, y: 80, width: 200, height: 120 },
      { x: 1400, y: 760, width: 200, height: 40 },
    ]);
    const img = PNG.sync.read(Buffer.from(await Bun.file(join(out, "page/desktop.png")).bytes()));
    expect(pixel(img, 10, 610)).toEqual([255, 0, 255, 255]);
  }, 60_000);

  test("a snapshot with no ignore areas records []", async () => {
    const result = await captureSnapshots(config, await tmp(), pinned);
    expect(result.manifest.snapshots.map((s) => s.ignore)).toEqual([[], [], []]);
  }, 60_000);

  test("toImageRects grows to whole pixels, clips, and drops what is empty", () => {
    const image = { width: 100, height: 50 };
    expect(
      toImageRects(
        [
          { x: 0.4, y: 0.4, width: 1, height: 1 },
          { x: 90, y: 40, width: 50, height: 50 },
          { x: 10, y: 10, width: 0, height: 5 },
          { x: 200, y: 0, width: 5, height: 5 },
        ],
        1,
        image,
      ),
    ).toEqual([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 90, y: 40, width: 10, height: 10 },
    ]);
  });
});

describe("paintRects", () => {
  test("clips a rectangle that runs off the image", () => {
    const img = new PNG({ width: 4, height: 4 });
    const out = PNG.sync.read(
      paintRects(PNG.sync.write(img), [{ x: 2, y: 2, width: 10, height: 10 }], 1),
    );
    expect(pixel(out, 3, 3)).toEqual([255, 0, 255, 255]);
    expect(pixel(out, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  test("scales CSS px by the device scale factor", () => {
    const img = new PNG({ width: 8, height: 8 });
    const out = PNG.sync.read(
      paintRects(PNG.sync.write(img), [{ x: 1, y: 1, width: 2, height: 2 }], 2),
    );
    expect(pixel(out, 2, 2)).toEqual([255, 0, 255, 255]);
    expect(pixel(out, 5, 5)).toEqual([255, 0, 255, 255]);
    expect(pixel(out, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 6, 6)).toEqual([0, 0, 0, 0]);
  });
});
