import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { readManifest } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { pngDir } from "./import-support.ts";

afterAll(cleanup);

/** The Button of docs/metrics.md, as a native emitter would write it. */
const BUTTON = {
  version: "1.0",
  root: "button",
  parts: {
    button: { box: { x: 0, y: 0, w: 96, h: 40 }, gap: 8, color: { bg: "#2563eb" } },
    "button.icon": { box: { x: 16, y: 12, w: 16, h: 16 } },
    "button.label": {
      box: { x: 40, y: 10, w: 40, h: 20 },
      font: { size: 14, weight: 600, lineHeight: 20 },
      color: { fg: "#ffffff" },
    },
  },
};

async function dirWithMetrics(metrics: unknown = BUTTON): Promise<string> {
  const dir = await pngDir();
  await Bun.write(join(dir, "home.metrics.json"), JSON.stringify(metrics));
  return dir;
}

async function importDir(from: string, ...extra: string[]) {
  const out = join(await tmp(), "snaps");
  const cap = capture();
  const code = await run(
    ["import", from, "--out", out, "--viewport", "800x600", ...extra],
    cap.io,
    {},
  );
  return { out, cap, code };
}

describe("pixelslash import with <name>.metrics.json (PS-294)", () => {
  test("carries the file into the snapshot dir and the manifest entry", async () => {
    const { out, cap, code } = await importDir(await dirWithMetrics());
    expect(code).toBe(0);
    expect(cap.stdout).toBe(
      `pixelslash: 2 snapshots\nmetrics: 1\nmanifest: ${join(out, "manifest.json")}\n`,
    );
    const { snapshots } = await readManifest(out);
    expect(snapshots.map((s) => [s.name, s.metrics])).toEqual([
      ["billing/invoice", undefined],
      ["home", "home.metrics.json"],
    ]);
    expect(await Bun.file(join(out, "home.metrics.json")).json()).toEqual(BUTTON);
  });

  test("without metrics files the output is as it was: no field, no line", async () => {
    const { out, cap, code } = await importDir(await pngDir());
    expect(code).toBe(0);
    expect(cap.stdout).toBe(`pixelslash: 2 snapshots\nmanifest: ${join(out, "manifest.json")}\n`);
    const raw = await Bun.file(join(out, "manifest.json")).text();
    expect(raw).not.toContain("metrics");
  });

  test("a malformed file is exit 2 and names the file", async () => {
    for (const bad of [
      '{"version":"1.0"',
      JSON.stringify({ ...BUTTON, version: "2.0" }),
      JSON.stringify({ ...BUTTON, root: "nope" }),
    ]) {
      const dir = await pngDir();
      await Bun.write(join(dir, "home.metrics.json"), bad);
      const { cap, code } = await importDir(dir);
      expect(code).toBe(2);
      expect(cap.stderr).toContain("home.metrics.json");
    }
  });

  test("a metrics file with no PNG beside it is exit 2", async () => {
    const dir = await pngDir();
    await Bun.write(join(dir, "orphan.metrics.json"), JSON.stringify(BUTTON));
    const { cap, code } = await importDir(dir);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("orphan.metrics.json");
  });
});
