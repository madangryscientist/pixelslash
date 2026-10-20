import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/upload.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function entry(name: string, extra: object = {}) {
  return {
    name,
    path: `/${name}`,
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      theme: "light",
    },
    tags: [],
    file: `${name}.png`,
    fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
    ...extra,
  };
}

async function manifestDir(snapshots: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-mdiff-"));
  dirs.push(dir);
  for (const s of snapshots) {
    if ("file" in s && typeof s.file === "string") await Bun.write(join(dir, s.file), PNG_HEAD);
  }
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots }));
  return dir;
}

describe("manifest diff options", () => {
  test("round-trip; a manifest from before the field reads as {}", async () => {
    const dir = await manifestDir([
      entry("home", { diff: { threshold: 0.2, minChangedPixels: 5 } }),
      entry("pricing"),
    ]);
    const [home, pricing] = (await readManifest(dir)).snapshots;
    expect(home?.diff).toEqual({ threshold: 0.2, minChangedPixels: 5 });
    expect(pricing?.diff).toEqual({});
  });

  test.each([
    [{ threshold: 3 }, /snapshots\[0\]\.diff\.threshold must be a number from 0 to 1/],
    [{ fuzz: 1 }, /snapshots\[0\]\.diff\.fuzz is not a diff option/],
    [0.2, /snapshots\[0\]\.diff must be an object/],
  ])("refuses diff %j", async (diff, message) => {
    const dir = await manifestDir([entry("x", { diff })]);
    await expect(readManifest(dir)).rejects.toThrow(message);
  });
});
