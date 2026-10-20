import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import { captureSnapshots, paintRects, type SnapshotManifest } from "../src/snapshot.ts";

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
  const routes = [{ path, name: "page", masks: [], tags: [], diff: {}, variantDiff: {} }];
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
      { path: "/", name: "index", masks: [".nope"], tags: [], diff: {}, variantDiff: {} },
    ];
    const result = await captureSnapshots({ ...config, routes }, await tmp(), {
      env: {},
      listFonts: async () => [],
      warn: (m) => warnings.push(m),
    });
    expect(result.manifest.snapshots[0]?.fingerprint.image).toBe("bare");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/outside the pinned PixelSlash image/);
    expect(warnings[1]).toBe('warning: mask ".nope" matched nothing on /');
  }, 60_000);
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
