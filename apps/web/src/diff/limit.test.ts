import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { diffLimitOf } from "./limit";
import { context, onlyShot, sha, upload } from "./test-builds";

/** Only the head of a PNG: the limit reads the size and nothing may get as far as decoding it. */
const tall = (height: number) => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(1280, 16);
  head.writeUInt32BE(height, 20);
  return new Uint8Array(head);
};

/** A build of one tall shot, whose baseline is one pixel taller so the two are not the same bytes. */
async function pair(height: number, diffLimitMpx: number | undefined) {
  const ctx = await context();
  let diffed = 0;
  const diff = () => {
    diffed++;
    throw new Error("diffed");
  };
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: tall(height) }] });
  const build = await upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: tall(height - 1) }] },
    { diff, diffLimitMpx },
  );
  return { build, held: await onlyShot(ctx, build), diffed };
}

describe("DIFF_LIMIT_MPX: a shot too large for this server errors the build, naming the limit", () => {
  test("over the limit: the build is errored with the size, and nothing is diffed", async () => {
    const { build, held, diffed } = await pair(16_800, 20);
    const said = "too large for a server diff on this server: 1280x16800 = 21.5 Mpx, limit 20 Mpx";
    expect(build.status).toBe("errored");
    expect(build.error).toContain(said);
    expect(held.diffError).toBe(said);
    expect(diffed).toBe(0);
  });

  test("at the limit: the same pair is diffed", async () => {
    // 1280 x 16800 is 21.504 Mpx exactly.
    const { held, diffed } = await pair(16_800, 21.504);
    expect(diffed).toBe(1);
    expect(held.diffError).toBe("diffed");
  });

  test("unset, as on Cloudflare: the same pair is diffed, with no limit", async () => {
    const { held, diffed } = await pair(16_800, undefined);
    expect(diffed).toBe(1);
    expect(held.diffError).not.toContain("too large");
  });
});

describe("diffLimitOf reads the var", () => {
  test("unset or empty is no limit", () => {
    expect(diffLimitOf(undefined)).toBeUndefined();
    expect(diffLimitOf("")).toBeUndefined();
    expect(diffLimitOf("  ")).toBeUndefined();
  });

  test("a positive number is the limit", () => {
    expect(diffLimitOf("20")).toBe(20);
    expect(diffLimitOf("12.5")).toBe(12.5);
  });

  test("anything else throws naming the var", () => {
    for (const raw of ["0", "-3", "twenty", "Infinity"])
      expect(() => diffLimitOf(raw)).toThrow(/DIFF_LIMIT_MPX must be a positive number/);
  });
});
