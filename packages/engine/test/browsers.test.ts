import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../src/capture.ts";
import { captureInto } from "../src/capture-into.ts";
import { CRASH_GRACE_MS } from "../src/crash-retry.ts";
import { IMAGE_BROWSERS, parseConfig, type BrowserName } from "../src/config.ts";
import { compareSnapshots } from "../src/compare-snapshots.ts";
import { readManifest } from "../src/manifest.ts";
import { renderPixelReport } from "../src/report.ts";
import {
  captureSnapshots,
  openCaptureSession,
  recapture,
  type CaptureSession,
} from "../src/snapshot.ts";
import { cleanupDev, png, tmpDir } from "./dev-fixtures.ts";

const dirs: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    // An image whose request is never answered: the page loads, but never settles.
    if (path === "/never") return new Promise<Response>(() => {});
    if (path === "/hangs")
      return new Response('<!doctype html><body><p>waiting</p><img src="/never">', {
        headers: { "content-type": "text/html" },
      });
    return new Response("<!doctype html><body><h1>Fixture</h1><p>Some text 🎨</p>", {
      headers: { "content-type": "text/html" },
    });
  },
});
afterAll(async () => {
  await server.stop(true);
  cleanupDev();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function out(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-browsers-"));
  dirs.push(dir);
  return dir;
}

/** Whether this machine can launch `name`: WebKit needs system libraries a dev box may lack. */
async function launches(name: BrowserName): Promise<boolean> {
  try {
    await (await launchBrowser(name)).close();
    return true;
  } catch {
    return false;
  }
}
const launchable = new Set<BrowserName>();
for (const b of IMAGE_BROWSERS) if (await launches(b)) launchable.add(b);

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };
/** The settle timeout the never-settling page is given. */
const SETTLE_MS = 1_500;
const base = { baseUrl: `http://127.0.0.1:${server.port}` };

describe("a variant's browser", { timeout: 60_000 }, () => {
  test("defaults to chromium and names the variant by it; firefox and webkit are accepted", () => {
    const config = parseConfig({
      ...base,
      routes: ["/"],
      variants: [{}, { browser: "firefox" }, { browser: "webkit", theme: "dark" }],
    });
    expect(config.variants.map((v) => [v.name, v.browser])).toEqual([
      ["chromium-1280x720-light", "chromium"],
      ["firefox-1280x720-light", "firefox"],
      ["webkit-1280x720-dark", "webkit"],
    ]);
  });

  test("a manifest names only the browsers the image ships", async () => {
    const dir = await out();
    const config = parseConfig({ ...base, routes: ["/"] });
    const fake = fakeSession(config, ["chromium", "firefox"]);
    await captureInto(fake, dir);
    const file = Bun.file(join(dir, "manifest.json"));
    const manifest = await file.json();
    expect((await readManifest(dir)).snapshots.map((e) => e.variant.browser)).toEqual([
      "chromium",
      "firefox",
    ]);
    manifest.snapshots[0].variant.browser = "edge";
    await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest));
    await expect(readManifest(dir)).rejects.toThrow(/variant\.browser must be one of chromium/);
  });
});

/** A browserless session with one variant per browser, each fingerprinted by its own browser. */
function fakeSession(
  config: ReturnType<typeof parseConfig>,
  browsers: BrowserName[],
): CaptureSession {
  const withVariants = {
    ...config,
    variants: browsers.map((browser) => ({
      name: browser,
      browser,
      viewport: { width: 16, height: 16 },
      theme: "light" as const,
    })),
  };
  return {
    config: withVariants,
    routes: config.routes,
    fingerprintFor: (browser) => ({
      image: "version:test",
      browser: `${browser} 1`,
      fonts: "sha256:f",
    }),
    browserLaunchMs: 0,
    shoot: async () => ({ png: png(), ignore: [], media: [] }),
    flush: () => {},
    close: async () => {},
  };
}

describe("one page × three browsers", { timeout: 60_000 }, () => {
  test("is three shots, each fingerprinted by the browser that took it", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const { manifest } = await captureInto(
      fakeSession(config, [...IMAGE_BROWSERS]),
      await tmpDir(),
    );
    expect(
      manifest.snapshots.map((e) => [e.variant.browser, e.fingerprint.browser, e.file]),
    ).toEqual([
      ["chromium", "chromium 1", "index/chromium.png"],
      ["firefox", "firefox 1", "index/firefox.png"],
      ["webkit", "webkit 1", "index/webkit.png"],
    ]);
  });

  test("a baseline is re-captured only in its own browser", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const fake = fakeSession(config, ["firefox"]);
    const used: string[] = [];
    fake.shoot = async (_, variant) => {
      used.push(variant.browser);
      return { png: png(), ignore: [], media: [] };
    };
    const variant = fake.config.variants[0]!;
    const entry = (browser: BrowserName) => ({ name: "index", variant: { ...variant, browser } });
    await recapture(fake, entry("firefox"));
    expect(used).toEqual(["firefox"]);
    // Same name, but the baseline was taken in another browser: the config no longer has it.
    expect(await recapture(fake, entry("webkit"))).toBeUndefined();
  });

  test("a compare matches a shot only against its own browser's baseline", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const [main, branch] = [await out(), await out()];
    await captureInto(fakeSession(config, ["chromium", "firefox"]), main);
    await captureInto(fakeSession(config, ["firefox", "webkit"]), branch);
    const result = await compareSnapshots({ mainDir: main, branchDir: branch, out: await out() });
    expect(result.unchanged.map((r) => r.shot)).toEqual([expect.stringContaining("firefox")]);
    expect(result.added.map((r) => r.shot)).toEqual([expect.stringContaining("webkit")]);
    expect(result.removed.map((r) => r.shot)).toEqual([expect.stringContaining("chromium")]);
  });

  test("the report names the browser on the shot", () => {
    const html = renderPixelReport({
      changedPixels: 0,
      regions: [],
      specks: { count: 0, pixels: 0 },
      browser: "firefox",
      main: { width: 4, height: 4 },
      branch: { width: 4, height: 4 },
    });
    expect(html).toContain("firefox · Main 4x4 · Branch 4x4");
  });
});

describe.each(IMAGE_BROWSERS)("a real %s", (name) => {
  test.skipIf(!launchable.has(name))(
    "captures a page, fingerprints itself, and writes the same bytes twice",
    async () => {
      const config = parseConfig({
        ...base,
        routes: ["/"],
        variants: [{ name: "small", browser: name, viewport: { width: 320, height: 200 } }],
      });
      const [a, b] = [await out(), await out()];
      const first = await captureSnapshots(config, a, pinned);
      await captureSnapshots(config, b, pinned);
      expect(first.manifest.snapshots[0]?.variant.browser).toBe(name);
      expect(first.manifest.snapshots[0]?.fingerprint.browser).toMatch(
        new RegExp(`^${name} \\d+\\.`),
      );
      const [left, right] = await Promise.all(
        [a, b].map((d) => Bun.file(join(d, "index/small.png")).bytes()),
      );
      expect(Buffer.compare(left ?? new Uint8Array(), right ?? new Uint8Array())).toBe(0);
      expect(left?.length).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!launchable.has(name))(
    "fails a page that never settles, inside the timeout",
    async () => {
      const config = parseConfig({
        ...base,
        routes: ["/hangs"],
        variants: [{ name: "small", browser: name, viewport: { width: 320, height: 200 } }],
        stabilise: { timeoutMs: SETTLE_MS },
      });
      // The clock starts once the browser is up: launching and closing a browser is the host's
      // cost, and says nothing about whether the settle timeout ends the capture. What is timed
      // is two attempts (a shot that times out is retried alone once the run has drained, so a
      // hang is paid twice), each the timeout plus the crash grace, and 8 s of margin for a busy
      // host. A capture that ignored the timeout would wait out Playwright's own 30 s, so the
      // bound still fails it.
      const session = await openCaptureSession(config, pinned);
      const dir = await out();
      let took: number;
      try {
        const began = Date.now();
        await expect(captureInto(session, dir, undefined, { warn() {} })).rejects.toThrow(
          /capture settle exceeded|Timeout/,
        );
        took = Date.now() - began;
      } finally {
        await session.close();
      }
      expect(took).toBeLessThan(2 * (SETTLE_MS + CRASH_GRACE_MS) + 8_000);
    },
    60_000,
  );
});
