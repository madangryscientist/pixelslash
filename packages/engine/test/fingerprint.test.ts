import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontSetHash, imageId } from "../src/fingerprint.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("imageId", () => {
  test("digest beats version; neither is bare", () => {
    expect(imageId({ PIXELSLASH_IMAGE_DIGEST: "sha256:abc", PIXELSLASH_IMAGE_VERSION: "1" })).toBe(
      "sha256:abc",
    );
    expect(imageId({ PIXELSLASH_IMAGE_VERSION: "1" })).toBe("version:1");
    expect(imageId({})).toBe("bare");
  });
});

describe("fontSetHash", () => {
  test("ignores list order and duplicates, changes with a font's bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixelslash-fonts-"));
    dirs.push(dir);
    const a = join(dir, "a.ttf");
    const b = join(dir, "b.ttf");
    await Bun.write(a, "font a");
    await Bun.write(b, "font b");
    const first = await fontSetHash(async () => [a, b]);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fontSetHash(async () => [b, a, b])).toBe(first);
    await Bun.write(b, "font b, hinted differently");
    expect(await fontSetHash(async () => [a, b])).not.toBe(first);
  });

  test("no fontconfig: unknown, not a made-up hash", async () => {
    expect(await fontSetHash(async () => undefined)).toBe("unknown");
  });
});
