import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInto } from "../src/capture-into.ts";
import { parseConfig } from "../src/config.ts";
import { openCaptureSession } from "../src/snapshot.ts";
import { buildTimings, captureFacts, loadNow, requestLog } from "../src/timings.ts";

/** The capture's speed profile: wall against worker time, the workers, the parts and the host. */

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    // Each page takes a moment, so two shots at once finish well inside the sum of their times.
    await Bun.sleep(150);
    const name = new URL(req.url).pathname;
    return new Response(
      `<!doctype html><title>${name}</title><body style="margin:0"><h1>${name}</h1></body>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

describe("captureInto's profile", { timeout: 60_000 }, () => {
  test("two shots at concurrency 2: the wall is under the workers' time, with the parts and the host", async () => {
    const config = parseConfig({
      baseUrl: `http://127.0.0.1:${server.port}`,
      routes: ["/a", "/b"],
      variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
    });
    const out = await mkdtemp(join(tmpdir(), "pixelslash-profile-"));
    dirs.push(out);
    const loadStart = loadNow();
    const session = await openCaptureSession(config, pinned);
    try {
      const result = await captureInto(session, out, 2);
      const timings = buildTimings(
        performance.now() - 1000,
        result.shots,
        session.browserLaunchMs,
        captureFacts(result, loadStart),
      );
      expect(timings.workers).toEqual({ capture: 2 });
      expect(timings.captureWallMs).toBeDefined();
      expect(timings.captureWallMs).toBeLessThan(timings.captureMs ?? 0);
      expect(timings.host?.cores).toBeGreaterThanOrEqual(1);
      expect(timings.host?.loadStart).toBe(loadStart);
      expect(timings.host?.loadEnd).toBeGreaterThanOrEqual(0);
      for (const shot of timings.shots) {
        expect(shot.setupMs).toBeGreaterThan(0);
        expect(shot.measureMs).toBeGreaterThanOrEqual(0);
        // Not a story: no render wait to time.
        expect(shot).not.toHaveProperty("storyMs");
      }
      expect(timings.setupMs).toBe(timings.shots.reduce((n, s) => n + (s.setupMs ?? 0), 0));
      expect(timings).not.toHaveProperty("storyMs");
    } finally {
      await session.close();
    }
  });

  test("one shot is one worker, whatever the limit", async () => {
    const config = parseConfig({
      baseUrl: `http://127.0.0.1:${server.port}`,
      routes: ["/a"],
      variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
    });
    const out = await mkdtemp(join(tmpdir(), "pixelslash-profile-"));
    dirs.push(out);
    const session = await openCaptureSession(config, pinned);
    try {
      expect((await captureInto(session, out, 4)).captureWorkers).toBe(1);
    } finally {
      await session.close();
    }
  });
});

describe("requestLog's spread", () => {
  test("p50 is no more than p90, no more than max, and the wall is under the summed time when requests overlap", async () => {
    const log = requestLog();
    const request = async (step: string, ms: number) => {
      await Bun.sleep(ms);
      log.record(step, ms);
    };
    await Promise.all([
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => request(`upload a/${ms}.png`, ms)),
      request("finalize", 5),
    ]);
    const { batches } = log.finish();
    const upload = batches.find((b) => b.step === "upload");
    expect(upload).toMatchObject({ count: 10, ms: 550, p50Ms: 50, p90Ms: 90, maxMs: 100 });
    expect(upload?.wallMs).toBeGreaterThanOrEqual(90);
    expect(upload?.wallMs).toBeLessThan(upload?.ms ?? 0);
    expect(batches.find((b) => b.step === "finalize")).toMatchObject({
      count: 1,
      p50Ms: 5,
      p90Ms: 5,
      maxMs: 5,
    });
  });
});
