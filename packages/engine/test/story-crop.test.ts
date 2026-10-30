import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import { captureSnapshots } from "../src/snapshot.ts";
import { shiftBoxes, storyCrop } from "../src/story-crop.ts";

/**
 * Storybook shots are cropped to the story (PS-286). The fake preview is Storybook's iframe reduced
 * to what capture reads: `#storybook-root`, the `sb-main-<layout>` body class, and whatever a story
 * portals into `<body>`.
 */

type Story = { root: string; portal?: string; layout?: string };

const STORIES: Record<string, Story> = {
  "ui-button--primary": {
    root: `<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">Go</button>`,
  },
  "ui-menu--open": {
    root: `<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">Menu</button>`,
    portal: `<div style="position:absolute;left:300px;top:200px;width:80px;height:60px;background:#06b">menu</div>`,
  },
  "ui-menu--hidden-portal": {
    root: `<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">Menu</button>`,
    portal: `<div style="position:absolute;left:300px;top:200px;width:80px;height:60px;visibility:hidden">x</div>`,
  },
  "ui-menu--fade-in": {
    root: `<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">Menu</button>`,
    portal: `<style>@keyframes fade{from{opacity:0}to{opacity:1}}</style><div style="position:absolute;left:300px;top:200px;width:80px;height:60px;background:#06b;animation:fade 1s 60s both">menu</div>`,
  },
  "ui-page--full": {
    layout: "fullscreen",
    root: `<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">Go</button>`,
  },
  "ui-clip--player": {
    root: `<video style="position:absolute;left:60px;top:60px;width:100px;height:50px"></video>`,
  },
  "ui-edge--corner": {
    root: `<button style="position:absolute;left:2px;top:3px;width:100px;height:40px">Go</button>`,
  },
};

const entries = Object.fromEntries(
  Object.keys(STORIES).map((id) => [
    id,
    { type: "story", id, title: id.split("--")[0], name: id.split("--")[1], tags: [] },
  ]),
);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/index.json") return Response.json({ v: 5, entries });
    if (pathname === "/plain")
      return new Response(`<!doctype html><body style="margin:0"><p>a route</p></body>`, {
        headers: { "content-type": "text/html" },
      });
    const story = STORIES[searchParams.get("id") ?? ""];
    if (pathname !== "/iframe.html" || !story) return new Response("nope", { status: 404 });
    const layout = story.layout ? ` sb-main-${story.layout}` : " sb-main-padded";
    return new Response(
      `<!doctype html><body class="sb-show-main${layout}" style="margin:0;background:#fff">
<div id="storybook-root">${story.root}</div>${story.portal ?? ""}
<div class="sb-errordisplay" style="width:900px;height:600px;display:none"></div>
<script>document.body.dataset.ready = "1";</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const url = `http://127.0.0.1:${server.port}`;
const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

function config(id: string, extra: Record<string, unknown> = {}, scale = 1) {
  return parseConfig({
    storybook: { url, include: [id] },
    variants: [{ name: "desktop", viewport: { width: 1280, height: 720 } }],
    stabilise: { timeoutMs: 5_000, deviceScaleFactor: scale },
    ...extra,
  });
}

/** The story `id` captured alone; its shot is named for the id with the `--` flattened. */
async function shoot(
  id: string,
  extra: Record<string, unknown> = {},
  scale = 1,
  name = id.replace("--", "-"),
) {
  const out = await mkdtemp(join(tmpdir(), "pixelslash-crop-"));
  dirs.push(out);
  const warnings: string[] = [];
  const { manifest } = await captureSnapshots(config(id, extra, scale), out, {
    ...pinned,
    warn: (m) => warnings.push(m),
  });
  const entry = manifest.snapshots.find((s) => s.name === name);
  if (!entry)
    throw new Error(`no shot ${name} in ${manifest.snapshots.map((s) => s.name).join(", ")}`);
  const png = PNG.sync.read(Buffer.from(await Bun.file(join(out, entry.file)).bytes()));
  return { entry, png, warnings };
}

describe("a Storybook shot is cropped to the story", { timeout: 60_000 }, () => {
  test("a small story is its own box plus 8 CSS px, not the viewport", async () => {
    const { png } = await shoot("ui-button--primary");
    expect([png.width, png.height]).toEqual([100 + 16, 40 + 16]);
  });

  test("at device scale 2 the crop is the same box in image px", async () => {
    const { png } = await shoot("ui-button--primary", {}, 2);
    expect([png.width, png.height]).toEqual([(100 + 16) * 2, (40 + 16) * 2]);
  });

  test("a visible element portalled into <body> is in the crop; a hidden one is not", async () => {
    const open = await shoot("ui-menu--open");
    // Button 50..150 × 50..90 and the menu 300..380 × 200..260, each side padded.
    expect([open.png.width, open.png.height]).toEqual([380 + 8 - 42, 260 + 8 - 42]);
    const hidden = await shoot("ui-menu--hidden-portal");
    expect([hidden.png.width, hidden.png.height]).toEqual([116, 56]);
  });

  test("a portal that fades in is measured where the shot shows it", async () => {
    const { png } = await shoot("ui-menu--fade-in");
    expect([png.width, png.height]).toEqual([380 + 8 - 42, 260 + 8 - 42]);
  });

  test("the crop is clipped to the page", async () => {
    const { png } = await shoot("ui-edge--corner");
    expect([png.width, png.height]).toEqual([2 + 100 + 8, 3 + 40 + 8]);
  });

  test("a fullscreen story keeps the full page", async () => {
    const { png } = await shoot("ui-page--full");
    expect([png.width, png.height]).toEqual([1280, 720]);
  });

  test("a route in the same config is not cropped", async () => {
    const { png } = await shoot(
      "ui-button--primary",
      { routes: [{ path: "/plain", name: "plain" }] },
      1,
      "plain",
    );
    expect([png.width, png.height]).toEqual([1280, 720]);
  });

  test("an ignored video still hatches on the pixels it covers", async () => {
    const { entry, png, warnings } = await shoot("ui-clip--player", { ignore: ["video"] });
    // The video is the whole story: 100x50 at (60,60), kept from (52,52).
    expect([png.width, png.height]).toEqual([116, 66]);
    expect(entry.ignore).toEqual([{ x: 8, y: 8, width: 100, height: 50 }]);
    // Only the unmatched-selector summary for the other stories; no media warning.
    expect(warnings.filter((w) => !w.includes("matched nothing"))).toEqual([]);
  });

  test("an unexcluded video is reported in the cropped frame", async () => {
    const { warnings } = await shoot("ui-clip--player");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("<video> at 8,8 100x50 on ui-clip-player");
  });

  test("a rectangle mask and a rectangle ignore are shifted with the crop", async () => {
    const { entry, png } = await shoot("ui-button--primary", {
      ignore: [{ x: 60, y: 60, width: 10, height: 10 }],
      masks: [{ x: 50, y: 50, width: 20, height: 20 }],
    });
    expect(entry.ignore).toEqual([{ x: 18, y: 18, width: 10, height: 10 }]);
    // Painted magenta from the box's own corner (8,8) in the cropped image.
    const at = (x: number, y: number) =>
      Array.from(png.data.subarray((y * png.width + x) * 4).slice(0, 4));
    expect(at(8, 8)).toEqual([255, 0, 255, 255]);
    expect(at(27, 27)).toEqual([255, 0, 255, 255]);
    expect(at(28, 28)).not.toEqual([255, 0, 255, 255]);
  });
});

describe("storyCrop and shiftBoxes", () => {
  const image = { width: 1280, height: 720 };

  test("rounds out to whole CSS px and clips to the image", () => {
    expect(storyCrop({ x: 10.4, y: 10.6, width: 20.3, height: 5 }, 1, image)).toEqual({
      origin: { x: 2, y: 2 },
      x: 2,
      y: 2,
      width: 37,
      height: 22,
    });
    expect(storyCrop({ x: 1270, y: 710, width: 10, height: 10 }, 1, image)).toMatchObject({
      width: 1280 - 1262,
      height: 720 - 702,
    });
  });

  test("a box that fills the page is not cropped", () => {
    expect(storyCrop({ x: 0, y: 0, width: 1280, height: 720 }, 1, image)).toBeNull();
  });

  test("boxes shift by the origin and are cut at the top and left", () => {
    const origin = { x: 10, y: 10 };
    expect(
      shiftBoxes(
        [
          { x: 15, y: 20, width: 5, height: 5 },
          { x: 5, y: 5, width: 10, height: 10 },
          { x: 0, y: 0, width: 4, height: 4 },
        ],
        origin,
      ),
    ).toEqual([
      { x: 5, y: 10, width: 5, height: 5 },
      { x: 0, y: 0, width: 5, height: 5 },
    ]);
  });
});
