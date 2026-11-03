import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { readManifest } from "../src/manifest.ts";
import { METRICS_SUFFIX, parseMetricsText } from "../src/metrics-entry.ts";
import { captureSnapshots, type SnapshotDeps } from "../src/snapshot.ts";

/**
 * Layout metrics per shot (PS-294), against a real browser: a button with an icon and a label whose
 * CSS is known, so the file's boxes, gap, padding, font and colours can be read back against it.
 */

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>metrics</title>
<style>
  body { margin: 0; padding: 20px; background: #fff; font: 16px sans-serif; }
  .button { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px;
    background: #2563eb; border: 0 solid transparent; height: 40px; box-sizing: border-box; }
  .icon { width: 16px; height: 16px; background: #ffffff; display: block; }
  .label { font: 600 14px/20px sans-serif; color: #ffffff; }
</style></head>
<body>
  <button class="button" data-part="button">
    <span class="icon" data-part="button.icon"></span>
    <span class="label" data-part="button.label">Save</span>
  </button>
  <ul><li data-part="row">a</li><li data-part="row">b</li></ul>
</body></html>`;

let root = "";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }),
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelslash-metrics-"));
});
afterAll(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const pinned: SnapshotDeps = {
  env: { PIXELSLASH_IMAGE_VERSION: "test" },
  listFonts: async () => [],
};

async function capture(metrics: boolean | undefined) {
  const config = parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [{ path: "/", name: "page" }],
    variants: [{ name: "desktop", viewport: { width: 600, height: 300 } }],
    ...(metrics !== undefined && { metrics }),
  });
  const out = await mkdtemp(join(root, "out-"));
  await captureSnapshots(config, out, pinned);
  return { out, manifest: await readManifest(out) };
}

describe("layout metrics at capture", { timeout: 60_000 }, () => {
  test("writes a file whose parts match the fixture's CSS", async () => {
    const { out, manifest } = await capture(true);
    const entry = manifest.snapshots[0];
    expect(entry?.metrics).toBe(`page/desktop${METRICS_SUFFIX}`);
    const text = await readFile(join(out, entry?.metrics ?? ""), "utf8");
    const m = parseMetricsText(text, "metrics", (what): never => {
      throw new Error(what);
    });
    expect(m.version).toBe("1.0");
    expect(m.root).toBe("button");
    expect(m.parts["button"]).toMatchObject({
      box: { x: 0, y: 0, w: expect.any(Number), h: 40 },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      gap: 8,
      color: { bg: "#2563eb" },
    });
    expect(m.parts["button.icon"]).toMatchObject({
      box: { x: 16, y: 12, w: 16, h: 16 },
      color: { bg: "#ffffff" },
    });
    expect(m.parts["button.icon"]?.font).toBeUndefined();
    const label = m.parts["button.label"];
    expect(label?.box).toMatchObject({ x: 40, y: 10, h: 20 });
    expect(label?.font).toEqual({ size: 14, weight: 600, lineHeight: 20 });
    expect(label?.color).toEqual({ fg: "#ffffff" });
  });

  test("two parts with one name get an index suffix", async () => {
    const { out, manifest } = await capture(true);
    const text = await readFile(join(out, manifest.snapshots[0]?.metrics ?? ""), "utf8");
    const m = parseMetricsText(text, "metrics", (what): never => {
      throw new Error(what);
    });
    expect(Object.keys(m.parts)).toEqual(expect.arrayContaining(["row", "row#2"]));
  });

  test("off by default: no file, no manifest field", async () => {
    const { out, manifest } = await capture(undefined);
    expect(manifest.snapshots[0]).not.toHaveProperty("metrics");
    const files = await readdir(join(out, "page"));
    expect(files.some((f) => f.endsWith(METRICS_SUFFIX))).toBe(false);
  });
});
