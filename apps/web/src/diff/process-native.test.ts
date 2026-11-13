import { describe, expect, test } from "vitest";
import { context, FINGERPRINT, rows, sha, upload, type Shot } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A native shot is compared with its own baseline: the same platform and the same device. A web
 * shot in the same build is left exactly as it was, and another device is another identity, never a
 * diff between the two. The upload contract (what is stored, what is refused) is `api/native.test.ts`.
 */

const screen = shot({ width: 120, height: 240 });
const moved = shot({ width: 120, height: 240, blocks: [{ x: 10, y: 20, w: 30, h: 20, rgb: RED }] });

const web: Shot = { name: "home", png: screen };

const android = (png: Shot["png"], device = "Pixel 8 API 35"): Shot => ({
  name: "login",
  png,
  renderer: { platform: "android", browser: device },
  fingerprint: { ...FINGERPRINT, platform: "android", device, scale: "3" },
});

/** The build's shots as [platform, browser, diff status], in a fixed order. */
async function statuses(
  ctx: Awaited<ReturnType<typeof context>>,
  build: Parameters<typeof rows>[1],
) {
  return (await rows(ctx, build))
    .map((s) => [s.platform, s.browser, s.diffStatus] as const)
    .toSorted((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

describe("native shots against their own baseline", () => {
  test("an android shot diffs against its own baseline and a web shot beside it is untouched; a new device is new, and the old one removed", async () => {
    const ctx = await context();
    const build = (n: number, mergeBase: number | undefined, shots: Shot[]) =>
      upload(ctx, {
        branch: "main",
        commit: sha(n),
        ...(mergeBase ? { ancestors: [sha(mergeBase)] } : {}),
        shots,
      });

    const first = await build(1, undefined, [web, android(screen)]);
    expect(await statuses(ctx, first)).toEqual([
      ["android", "Pixel 8 API 35", "new"],
      ["linux", "chromium", "new"],
    ]);

    const second = await build(2, 1, [web, android(screen)]);
    expect(await statuses(ctx, second)).toEqual([
      ["android", "Pixel 8 API 35", "unchanged"],
      ["linux", "chromium", "unchanged"],
    ]);

    const third = await build(3, 2, [web, android(moved)]);
    expect(await statuses(ctx, third)).toEqual([
      ["android", "Pixel 8 API 35", "changed"],
      ["linux", "chromium", "unchanged"],
    ]);

    const fourth = await build(4, 3, [web, android(moved, "Pixel 6 API 34")]);
    expect(await statuses(ctx, fourth)).toEqual([
      ["android", "Pixel 6 API 34", "new"],
      ["android", "Pixel 8 API 35", "removed"],
      ["linux", "chromium", "unchanged"],
    ]);
  });
});
