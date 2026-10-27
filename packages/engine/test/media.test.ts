import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, resolveDiff } from "../src/config.ts";
import { measureRepro, mediaOfShots, suggestFixes, type Repro } from "../src/flake-repro.ts";
import { mediaWarning } from "../src/media.ts";
import { toImageRects, unexcluded } from "../src/page-areas.ts";
import { captureSnapshots, openCaptureSession, type SnapshotDeps } from "../src/snapshot.ts";

/**
 * Media on a page (PS-230): capture measures each `<video>` and `<audio>` after the settle, warns
 * once per shot with the rect to exclude, and a flake check offers that exclusion first. The pages
 * are written under the test's TMPDIR, so no fixture in the repo carries a video.
 */

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>media</title>
<style>body { margin: 0; background: #fff; } .at { position: absolute; }</style></head>
<body>${body}</body></html>`;

const VIDEO = `<video class="at" style="left:580px;top:36px;width:112px;height:118px"></video>`;
const AUDIO = `<audio controls class="at" style="left:20.5px;top:300.25px;width:100px;height:30px"></audio>`;
// A box that lands somewhere new in the video's own strip on every load.
const RANDOM_IN_VIDEO = `
<video class="at" style="left:100px;top:100px;width:300px;height:100px"></video>
<div id="box" class="at" style="top:120px;width:20px;height:20px;background:#e11d48"></div>
<script>
  const [r] = crypto.getRandomValues(new Uint32Array(1));
  document.getElementById("box").style.left = (100 + (r % 260)) + "px";
</script>`;

const PAGES: Record<string, string> = {
  "/video": page(`<h1>A page</h1>${VIDEO}`),
  "/novideo": page("<h1>A page</h1>"),
  "/audio": page(AUDIO),
  "/random": page(RANDOM_IN_VIDEO),
};

let root = "";
const dirs: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const html = PAGES[new URL(req.url).pathname];
    if (!html) return new Response("not found", { status: 404 });
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelslash-media-"));
  dirs.push(root);
});
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

function config(routes: unknown[], variants: unknown[] = [{ name: "desktop" }]) {
  return parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes,
    variants: variants.map((v) => ({ viewport: { width: 800, height: 400 }, ...Object(v) })),
  });
}

async function capture(cfg: ReturnType<typeof config>) {
  const out = await mkdtemp(join(root, "out-"));
  const warnings: string[] = [];
  const deps: SnapshotDeps = { ...pinned, warn: (m) => warnings.push(m) };
  const result = await captureSnapshots(cfg, out, deps);
  return { result, warnings, out };
}

describe("capture warns about media", () => {
  test("a <video> at a known rect: the page captures and warns once with that rect", async () => {
    const { result, warnings, out } = await capture(config([{ path: "/video", name: "page" }]));
    expect(result.manifest.snapshots).toHaveLength(1);
    expect(warnings).toEqual([
      "warning: <video> at 580,36 112x118 on page (desktop) — media renders unreliably; add an exclusion zone (route.ignore) for this shot",
    ]);
    expect(Object.values(result.media)).toEqual([
      [{ tag: "video", x: 580, y: 36, width: 112, height: 118 }],
    ]);
    // The manifest stays byte-reproducible: media is in the result, never in the manifest.
    expect(await Bun.file(join(out, "manifest.json")).text()).not.toContain('"media"');
  }, 60_000);

  test("the same page without the video warns nothing and reports no media", async () => {
    const { result, warnings } = await capture(config([{ path: "/novideo", name: "page" }]));
    expect(warnings).toEqual([]);
    expect(result.media).toEqual({});
  }, 60_000);

  test("a video already inside the variant's configured ignore rect does not warn", async () => {
    const inside = { x: 570, y: 30, width: 130, height: 130 };
    const { result, warnings } = await capture(
      config([{ path: "/video", name: "page", ignore: [inside] }]),
    );
    expect(warnings).toEqual([]);
    expect(result.media).toEqual({});
  }, 60_000);

  test("an <audio> box is grown to whole CSS px, so it can be pasted into an ignore rect", async () => {
    const { result, warnings } = await capture(config([{ path: "/audio", name: "page" }]));
    expect(Object.values(result.media)).toEqual([
      [{ tag: "audio", x: 20, y: 300, width: 101, height: 31 }],
    ]);
    expect(warnings[0]).toContain("<audio> at 20,300 101x31");
  }, 60_000);

  test("one warning per shot and rect, however often the shot is captured again", async () => {
    const cfg = config([{ path: "/video", name: "page" }]);
    const warnings: string[] = [];
    const session = await openCaptureSession(cfg, { ...pinned, warn: (m) => warnings.push(m) });
    try {
      const [route] = session.routes;
      const [variant] = cfg.variants;
      if (!route || !variant) throw new Error("no route or variant");
      for (let i = 0; i < 3; i++) await session.shoot(route, variant);
    } finally {
      await session.close();
    }
    expect(warnings).toHaveLength(1);
  }, 60_000);
});

describe("unexcluded", () => {
  const image = { width: 800, height: 400 };
  const video = { tag: "video", x: 580, y: 36, width: 112, height: 118 } as const;

  test("a video only partly inside an ignore rect is kept, with its whole box", () => {
    const part = { x: 580, y: 36, width: 112, height: 60 };
    expect(unexcluded([video], [part], 1, image)).toEqual([video]);
  });

  test("a video that is itself the ignore element is covered at a fractional box and 2x", () => {
    // 20.5 + 100 wide at 2x: the ignore area resolves to 41..241, the whole-px box would be 40..242.
    const frac = { tag: "audio", x: 20.5, y: 300.25, width: 100, height: 30 } as const;
    const retina = { width: image.width * 2, height: image.height * 2 };
    const [resolved] = toImageRects([frac], 2, retina);
    expect(resolved).toEqual({ x: 41, y: 600, width: 200, height: 61 });
    expect(unexcluded([frac], resolved ? [resolved] : [], 2, retina)).toEqual([]);
    // Without the fix the whole-px box (20,300 101x31) would reach past it and warn.
    expect(unexcluded([frac], [], 2, retina)).toHaveLength(1);
  });
});

describe("mediaWarning", () => {
  const cfg = config([{ path: "/video", name: "page" }]);
  const [route] = cfg.routes;
  const [variant] = cfg.variants;
  const m = { tag: "video", x: 1, y: 2, width: 3, height: 4 } as const;

  test("a story is told to mark the element, since its route is not in the config", () => {
    if (!route || !variant) throw new Error("no route or variant");
    const story = { ...route, storybook: { origin: "http://x", id: "a--b" } };
    expect(mediaWarning(story, variant, m)).toBe(
      "warning: <video> at 1,2 3x4 on page (desktop) — media renders unreliably; mark it with data-pixelslash-ignore in the story",
    );
  });
});

describe("a flaky shot that holds media", () => {
  test("is offered the ignore for the media rect first, and the differing area inside it is not offered twice", async () => {
    const cfg = config([{ path: "/random", name: "random" }]);
    const session = await openCaptureSession(cfg, { ...pinned, warn: () => {} });
    try {
      const [route] = session.routes;
      const [variant] = cfg.variants;
      if (!route || !variant) throw new Error("no route or variant");
      const shots = [];
      for (let i = 0; i < 4; i++) shots.push(await session.shoot(route, variant));
      const repro = measureRepro(shots, resolveDiff(cfg, route, variant));
      expect(repro.stable).toBe(false);
      const media = mediaOfShots(shots);
      expect(media).toEqual([{ tag: "video", x: 100, y: 100, width: 300, height: 100 }]);
      const fixes = suggestFixes(repro, cfg, { route, variant, media });
      expect(fixes[0]?.edit).toEqual({
        kind: "ignore",
        route: "random",
        variant: "desktop",
        rect: { x: 100, y: 100, width: 300, height: 100 },
      });
      expect(fixes[0]?.text).toContain("<video> 300x100 at 100,100");
      // The moving box is inside the video's strip: its own area is the media's, so one ignore edit.
      expect(fixes.filter((f) => f.edit?.kind === "ignore")).toHaveLength(1);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("suggestFixes with media", () => {
  const cfg = config([{ path: "/video", name: "page" }]);
  const [route] = cfg.routes;
  const [variant] = cfg.variants;
  const media = [{ tag: "video", x: 580, y: 36, width: 112, height: 118 }] as const;
  const outside: Repro = {
    runs: [],
    differed: [2],
    stable: false,
    area: { x: 10, y: 10, width: 20, height: 20 },
  };

  test("a differing area outside the media keeps its own ignore suggestion, after the media's", () => {
    if (!route || !variant) throw new Error("no route or variant");
    const edits = suggestFixes(outside, cfg, { route, variant, media: [...media] })
      .map((f) => f.edit)
      .filter((e) => e?.kind === "ignore");
    expect(edits).toEqual([
      {
        kind: "ignore",
        route: "page",
        variant: "desktop",
        rect: { x: 580, y: 36, width: 112, height: 118 },
      },
      {
        kind: "ignore",
        route: "page",
        variant: "desktop",
        rect: { x: 10, y: 10, width: 20, height: 20 },
      },
    ]);
  });

  test("a story's media fix is in words, with no config edit", () => {
    if (!route || !variant) throw new Error("no route or variant");
    const story = { ...route, storybook: { origin: "http://x", id: "a--b" } };
    const [first] = suggestFixes(outside, cfg, { route: story, variant, media: [...media] });
    expect(first?.edit).toBeUndefined();
    expect(first?.text).toContain("data-pixelslash-ignore");
  });
});
