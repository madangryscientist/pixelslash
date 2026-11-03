import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng, tmp } from "./support.ts";
import { metaApi, pngDir } from "./import-support.ts";
import { gitRepo } from "./upload-support.ts";
import { readManifest } from "@hackcove/pixelslash-engine";

afterAll(cleanup);

/**
 * What Maestro leaves for an Android emulator or an iOS Simulator, generated here (no binaries in
 * the tree): the PNGs are the logical viewport times the device pixel ratio, with a shade per shot.
 */
async function nativeDir(shade: number, size = { width: 120, height: 240 }): Promise<string> {
  const dir = await tmp();
  await Bun.write(join(dir, "home.png"), solidPng(size.width, size.height, [shade, 100, 100, 255]));
  await Bun.write(
    join(dir, "login/form.png"),
    solidPng(size.width, size.height, [100, shade, 100, 255]),
  );
  return dir;
}

const PIXEL_8 = "Pixel 8 API 35";

const flags = (device: string, scale = "3") => [
  "--platform",
  "android",
  "--device",
  device,
  "--scale",
  scale,
];

async function importNative(from: string, ...extra: string[]): Promise<string> {
  const out = join(await tmp(), "snaps");
  const cap = capture();
  const argv = ["import", from, "--out", out, ...extra];
  expect(await run(argv, cap.io, {})).toBe(0);
  return out;
}

describe("pixelslash import --platform (PS-293)", () => {
  test("an android import writes platform, device and scale, and derives the viewport from the PNG", async () => {
    const [from, out] = [await nativeDir(100), join(await tmp(), "snaps")];
    const cap = capture();
    const argv = [
      "import",
      from,
      "--out",
      out,
      "--platform",
      "android",
      "--device",
      PIXEL_8,
      "--scale",
      "3",
    ];
    expect(await run(argv, cap.io, {})).toBe(0);
    expect(cap.stdout).toBe(`pixelslash: 2 snapshots\nmanifest: ${join(out, "manifest.json")}\n`);
    expect(cap.stderr).toContain("home.png: 120x240 px at scale 3 is viewport 40x80");

    const { snapshots } = await Bun.file(join(out, "manifest.json")).json();
    expect(snapshots[0]).toMatchObject({
      name: "home",
      platform: "android",
      device: PIXEL_8,
      scale: 3,
      variant: { browser: "chromium", viewport: { width: 40, height: 80 } },
      fingerprint: {
        image: "external",
        browser: "external",
        fonts: "unknown",
        platform: "android",
        device: PIXEL_8,
        scale: "3",
      },
    });
    expect((await readManifest(out)).snapshots[0]).toMatchObject({ platform: "android", scale: 3 });
  });

  test("upload sends the platform and the device as the server's key and keeps web's linux", async () => {
    const [native, web, cwd] = [
      await importNative(
        await nativeDir(100),
        "--platform",
        "ios",
        "--device",
        "iPhone 15",
        "--scale",
        "3",
      ),
      await importNative(await pngDir(), "--viewport", "800x600"),
      await gitRepo(),
    ];
    const sent: Record<string, unknown>[][] = [];
    for (const dir of [native, web]) {
      const api = metaApi();
      const cap = capture();
      const code = await run(["upload", dir, "--server", "https://ps.example"], cap.io, {
        fetch: api.fetch,
        cwd,
        env: { PIXELSLASH_TOKEN: "psci_t" },
      });
      expect(code).toBe(0);
      sent.push(api.metas);
    }
    expect(sent[0]?.map((m) => [m.platform, m.browser, m.viewport])).toEqual(
      expect.arrayContaining([["ios", "iPhone 15", "40x80"]]),
    );
    expect(sent[0]?.[0]?.fingerprint).toMatchObject({
      platform: "ios",
      device: "iPhone 15",
      scale: "3",
    });
    // A web import is as it was: linux, chromium, a fingerprint of three fields.
    expect(sent[1]?.map((m) => [m.platform, m.browser])).toEqual([
      ["linux", "chromium"],
      ["linux", "chromium"],
    ]);
    expect(sent[1]?.[0]?.fingerprint).toEqual({
      image: "external",
      browser: "external",
      fonts: "unknown",
    });
  });

  test("a PNG that is not viewport x scale is accepted, and the note names both sizes", async () => {
    const from = await nativeDir(100, { width: 1080, height: 2400 });
    const out = join(await tmp(), "snaps");
    const cap = capture();
    const argv = [
      "import",
      from,
      "--out",
      out,
      "--platform",
      "android",
      "--device",
      PIXEL_8,
      "--scale",
      "2.625",
      "--viewport",
      "411x914",
    ];
    expect(await run(argv, cap.io, {})).toBe(0);
    // 411x914 at 2.625 rounds to 1079x2399: the PNG is 1080x2400, so both are stated and the entry keeps what it was given.
    expect(cap.stderr).toContain(
      "1080x2400 px, but viewport 411x914 at scale 2.625 is 1079x2399; filed as given",
    );
    const { snapshots } = await Bun.file(join(out, "manifest.json")).json();
    expect(snapshots[0].variant.viewport).toEqual({ width: 411, height: 914 });
  });

  test("a web import with no native flag writes no platform, device or scale", async () => {
    const out = await importNative(await pngDir(), "--viewport", "800x600");
    const raw = await Bun.file(join(out, "manifest.json")).text();
    for (const key of ["platform", "device", "scale"]) expect(raw).not.toContain(`"${key}"`);
    // `--platform web` is the same words for the same thing.
    const named = await importNative(await pngDir(), "--viewport", "800x600", "--platform", "web");
    expect(await Bun.file(join(named, "manifest.json")).text()).toBe(raw);
  });

  test("a bad platform, a missing device or scale, or a native flag on web is exit 2", async () => {
    const [from, root] = [await nativeDir(100), await tmp()];
    const out = join(root, "out");
    const tries: [string[], RegExp][] = [
      [["--platform", "windows"], /--platform must be one of web, android, ios/],
      [["--platform", "android", "--scale", "3"], /needs --device/],
      [["--platform", "ios", "--device", "iPhone 15"], /needs --scale/],
      [
        ["--platform", "android", "--device", PIXEL_8, "--scale", "0"],
        /--scale must be a number above 0/,
      ],
      [
        ["--platform", "android", "--device", PIXEL_8, "--scale", "big"],
        /--scale must be a number above 0/,
      ],
      [
        ["--platform", "android", "--device", "Pixel<8>", "--scale", "3"],
        /--device .* must be 1 to 80/,
      ],
      [["--device", PIXEL_8], /--device and --scale are for --platform android\|ios/],
      [
        ["--platform", "web", "--scale", "2"],
        /--device and --scale are for --platform android\|ios/,
      ],
    ];
    for (const [argv, message] of tries) {
      const cap = capture();
      expect(await run(["import", from, "--out", out, ...argv], cap.io, {})).toBe(2);
      expect(cap.stderr).toMatch(message);
      expect(cap.stdout).toBe("");
    }
    expect(await Bun.file(join(out, "manifest.json")).exists()).toBe(false);
  });

  test("a manifest from before PS-293 reads as web, and a half-native entry is refused", async () => {
    const out = await importNative(await pngDir(), "--viewport", "800x600");
    const path = join(out, "manifest.json");
    const manifest = await Bun.file(path).json();
    expect((await readManifest(out)).snapshots[0]?.platform).toBeUndefined();
    for (const bad of [
      { platform: "android", scale: 3 },
      { platform: "android", device: PIXEL_8 },
      { platform: "linux", device: PIXEL_8, scale: 3 },
      { device: PIXEL_8 },
    ]) {
      await Bun.write(
        path,
        JSON.stringify({ ...manifest, snapshots: [{ ...manifest.snapshots[0], ...bad }] }),
      );
      await expect(readManifest(out)).rejects.toThrow(/manifest:/);
    }
    // "web" spelled out is the same as no field.
    await Bun.write(
      path,
      JSON.stringify({ ...manifest, snapshots: [{ ...manifest.snapshots[0], platform: "web" }] }),
    );
    expect((await readManifest(out)).snapshots[0]?.platform).toBeUndefined();
  });

  test("compare pairs only the same platform and device; a changed device is new and removed, not a diff", async () => {
    const [pixel8, pixel8Again, pixel9] = [
      await importNative(await nativeDir(100), ...flags(PIXEL_8)),
      await importNative(await nativeDir(140), ...flags(PIXEL_8)),
      await importNative(await nativeDir(140), ...flags("Pixel 9 API 35")),
    ];
    const same = capture();
    expect(
      await run(["compare", pixel8, pixel8Again, "--out", join(await tmp(), "r")], same.io, {}),
    ).toBe(0);
    expect(same.stdout).toMatch(/2 changed, 0 unchanged, 0 new, 0 removed/);

    const moved = capture();
    const report = join(await tmp(), "r");
    expect(await run(["compare", pixel8, pixel9, "--out", report], moved.io, {})).toBe(0);
    expect(moved.stdout).toMatch(/0 changed, 0 unchanged, 2 new, 2 removed/);
    const html = await Bun.file(join(report, "index.html")).text();
    expect(html).toContain("android");
    expect(html).toContain("Pixel 9 API 35");
    expect(html).not.toMatch(/browser[^<]*Pixel/i);
  });
});
