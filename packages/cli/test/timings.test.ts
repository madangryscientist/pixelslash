import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import {
  DS,
  capture,
  cleanup,
  faintPair,
  newMissSpawn,
  readManifest,
  servePages,
  servePaths,
  tmp,
} from "./support.ts";

afterAll(cleanup);

function nonNegative(ms: unknown): boolean {
  return typeof ms === "number" && Number.isInteger(ms) && ms >= 0;
}

describe("step timings (ob 1791)", () => {
  test("a run on existing PNGs records diff but no capture, in the manifest, the report and a stderr line", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {});
    expect(code).toBe(0);
    // stdout keeps its first line.
    expect(cap.stdout.split("\n")[0]).toBe("pixelslash: 400 changed pixels");
    // The PNGs are only copied, so there is no capture step: absent, not 0.
    expect(cap.stderr).toMatch(/^timing: 1 shot, diff \d+\.\ds, total \d+\.\ds\n$/);

    const { timings } = await readManifest(join(dir, "manifest.json"));
    expect(timings).toBeDefined();
    expect(timings?.shots).toHaveLength(1);
    const [shot] = timings?.shots ?? [];
    for (const ms of [timings?.totalMs, timings?.diffMs, shot?.diffMs])
      expect(nonNegative(ms)).toBe(true);
    expect(timings).not.toHaveProperty("captureMs");
    expect(shot).not.toHaveProperty("captureMs");
    // No judge ran, so there is no judge timing: absent, not 0.
    expect(timings).not.toHaveProperty("judgeMs");
    expect(shot).not.toHaveProperty("judgeMs");
    expect(timings).not.toHaveProperty("upload");

    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("Timings");
    expect(html).not.toContain("Judge</th>");
  });

  test("a judged run adds the judge step; a run with no judge has none", async () => {
    const dir = await tmp();
    const judged = capture();
    await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        join(dir, "a"),
      ],
      judged.io,
      { spawn: newMissSpawn() },
    );
    const a = await readManifest(join(dir, "a/manifest.json"));
    expect(nonNegative(a.timings?.judgeMs)).toBe(true);
    expect(nonNegative(a.timings?.shots[0]?.judgeMs)).toBe(true);
    expect(await Bun.file(join(dir, "a/report.html")).text()).toContain("Judge</th>");
    expect(judged.stderr).toMatch(/judge \d+\.\ds/);

    const skipped = capture();
    await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        join(dir, "b"),
      ],
      skipped.io,
      { which: () => null },
    );
    expect(skipped.stdout).toContain("skip: no judge");
    expect(skipped.stderr).not.toContain("judge");
    const b = await readManifest(join(dir, "b/manifest.json"));
    expect(b.timings).toBeDefined();
    expect(b.timings).not.toHaveProperty("judgeMs");
    expect(b.timings?.shots[0]).not.toHaveProperty("judgeMs");
  });

  const PARTS = {
    navigateMs: expect.any(Number),
    settleMs: expect.any(Number),
    screenshotMs: expect.any(Number),
    settle: {
      fontsMs: expect.any(Number),
      imagesMs: expect.any(Number),
      networkIdleMs: expect.any(Number),
      framesMs: expect.any(Number),
    },
  };

  test("a URL pair splits capture into navigate, settle and screenshot, with the browser launch (PS-195)", async () => {
    const dir = await tmp();
    const pages = await servePages();
    const cap = capture();
    const argv = ["--live", pages.url("live.html"), "--local", pages.url("local.html")];
    expect(await run([...argv, "--out", dir], cap.io, {})).toBe(0);
    const { timings } = await readManifest(join(dir, "manifest.json"));
    expect(timings).toMatchObject({ browserLaunchMs: expect.any(Number), ...PARTS });
    expect(timings?.shots[0]).toMatchObject(PARTS);
    // The settle is the network-idle wait at least. The two pages are shot at once, so their parts
    // add up to no more than twice the pair's capture.
    const {
      navigateMs = 0,
      settleMs = 0,
      screenshotMs = 0,
      captureMs = 0,
      settle,
    } = timings?.shots[0] ?? {};
    expect(settleMs).toBeGreaterThanOrEqual(settle?.networkIdleMs ?? Infinity);
    expect(navigateMs + settleMs + screenshotMs).toBeLessThanOrEqual(2 * captureMs);
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("<th>Navigate</th>");
    expect(html).toMatch(/browser launch \d+ ms · settle: fonts \d+ ms/);
  }, 60_000);

  test("capture --json carries the parts per shot and the launch once (PS-195)", async () => {
    const dir = await tmp();
    const config = join(dir, "pixelslash.config.json");
    await Bun.write(
      config,
      JSON.stringify({
        baseUrl: servePaths({ "/": "live.html" }),
        routes: ["/"],
        variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
      }),
    );
    const cap = capture();
    const argv = ["capture", "--config", config, "--out", join(dir, "out"), "--json"];
    const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };
    expect(await run(argv, cap.io, pinned)).toBe(0);
    const { timings } = JSON.parse(cap.stdout);
    expect(timings).toMatchObject({ browserLaunchMs: expect.any(Number), ...PARTS });
    expect(timings.shots[0]).toMatchObject(PARTS);
  }, 60_000);
});
