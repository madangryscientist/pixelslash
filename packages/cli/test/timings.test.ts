import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { DS, capture, cleanup, faintPair, newMissSpawn, readManifest, tmp } from "./support.ts";

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
});
