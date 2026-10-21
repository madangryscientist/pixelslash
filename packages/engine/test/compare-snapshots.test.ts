import { afterAll, describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSnapshots } from "../src/compare-snapshots.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

function solidPng(): Buffer {
  const img = new PNG({ width: 2, height: 2 });
  img.data.fill(255);
  return PNG.sync.write(img);
}

function entry(name: string, theme: "light" | "dark") {
  return {
    name,
    path: `/${name}`,
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      theme,
    },
    tags: [],
    file: `${name}-${theme}.png`,
    fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
  };
}

async function snapshotDir(snapshots: ReturnType<typeof entry>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-compare-"));
  dirs.push(dir);
  for (const s of snapshots) await Bun.write(join(dir, s.file), solidPng());
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots }));
  return dir;
}

async function compareOf(
  main: ReturnType<typeof entry>[],
  branch: ReturnType<typeof entry>[],
): Promise<string[]> {
  const out = await mkdtemp(join(tmpdir(), "pixelslash-compare-out-"));
  dirs.push(out);
  const result = await compareSnapshots({
    mainDir: await snapshotDir(main),
    branchDir: await snapshotDir(branch),
    out,
  });
  return result.unchanged.map((r) => r.shot);
}

describe("compare shot labels", () => {
  test("a compare that shot one colour scheme does not print it", async () => {
    expect(await compareOf([entry("home", "light")], [entry("home", "light")])).toEqual([
      "chromium 1280x720",
    ]);
  });

  test("a compare that varied the colour scheme names it as what the browser preferred", async () => {
    const both = [entry("home", "light"), entry("home", "dark")];
    expect(await compareOf(both, both)).toEqual([
      "chromium 1280x720 prefers: light",
      "chromium 1280x720 prefers: dark",
    ]);
  });
});
