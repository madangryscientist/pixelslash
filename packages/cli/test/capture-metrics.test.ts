import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { readManifest } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";

afterAll(cleanup);

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

const PAGE = `<!doctype html><html><body style="margin:0;padding:10px">
<button data-part="button" style="width:80px;height:30px;background:#2563eb">Save</button>
</body></html>`;

/**
 * `pixelslash capture` itself, not the engine's `captureSnapshots`: the CLI wraps the session to
 * count shots, and that wrapper once dropped what a shot is asked to read (PS-294).
 */
async function captured(metrics: boolean | undefined) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
  });
  try {
    const dir = await tmp();
    const config = join(dir, "pixelslash.config.json");
    await Bun.write(
      config,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${server.port}`,
        routes: [{ path: "/", name: "page" }],
        variants: [{ name: "small", viewport: { width: 300, height: 200 } }],
        ...(metrics !== undefined && { metrics }),
      }),
    );
    const cap = capture();
    const out = join(dir, "out");
    const code = await run(["capture", "--config", config, "--out", out], cap.io, pinned);
    return { code, out, stderr: cap.stderr, manifest: await readManifest(out) };
  } finally {
    await server.stop(true);
  }
}

describe("pixelslash capture with `metrics` (PS-294)", { timeout: 60_000 }, () => {
  test("on: each shot's file is written beside its PNG and named by the entry", async () => {
    const { code, out, manifest } = await captured(true);
    expect(code).toBe(0);
    expect(manifest.snapshots[0]?.metrics).toBe("page/small.metrics.json");
    const file = JSON.parse(await Bun.file(join(out, "page/small.metrics.json")).text());
    expect(file.root).toBe("button");
    expect(file.parts.button.box).toEqual({ x: 0, y: 0, w: 80, h: 30 });
  });

  test("off, or unset: no file and no `metrics` in the manifest", async () => {
    for (const metrics of [false, undefined]) {
      const { code, out, manifest } = await captured(metrics);
      expect(code).toBe(0);
      expect(manifest.snapshots[0]).not.toHaveProperty("metrics");
      expect(await Bun.file(join(out, "page/small.metrics.json")).exists()).toBe(false);
    }
  });
});
