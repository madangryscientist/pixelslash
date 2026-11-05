import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, test } from "vitest";
import { resetFallbackLog } from "./sidecar";
import { context, onlyShot, sha, upload } from "./test-builds";

beforeEach(() => resetFallbackLog());

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
async function refused(height: number, diffSidecar: string) {
  const ctx = await context();
  await upload(
    ctx,
    { branch: "main", commit: sha(1), shots: [{ png: tall(height) }] },
    { diffSidecar },
  );
  const build = await upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: tall(height - 1) }] },
    { diffSidecar },
  );
  return { build, held: await onlyShot(ctx, build) };
}

describe("a shot too tall to diff safely errors the build, naming the limit (PS-323)", () => {
  test("above the sidecar's limit: never sent to it, and no in-process diff", async () => {
    let asked = 0;
    const counting = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        asked++;
        return new Response("boom", { status: 500 });
      },
    });
    try {
      const { build, held } = await refused(40_000, `http://127.0.0.1:${counting.port}`);
      expect(build.status).toBe("errored");
      const said = "too large for a server diff: 1280x40000 = 51.2 Mpx, limit 24.5 Mpx";
      expect(build.error).toContain(said);
      expect(held.diffError).toBe(said);
      expect(asked).toBe(0);
    } finally {
      await counting.stop(true);
    }
  });

  test("the sidecar fails on a tall shot: not added to workerd", async () => {
    const failing = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    });
    try {
      const { build, held } = await refused(16_800, `http://127.0.0.1:${failing.port}`);
      expect(build.status).toBe("errored");
      expect(held.diffError).toBe(
        "too large for an in-process diff without the diff sidecar: " +
          "1280x16800 = 21.5 Mpx, limit 12.5 Mpx",
      );
    } finally {
      await failing.stop(true);
    }
  });

  test("a DIFF_SIDECAR_URL it refuses to call: the limit still holds", async () => {
    const { build } = await refused(16_800, "http://example.com");
    expect(build.status).toBe("errored");
    expect(build.error).toContain("limit 12.5 Mpx");
  });

  test("with no sidecar configured the limit does not apply", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: tall(40_000) }] });
    const build = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: tall(39_999) }],
    });
    // Reaches the diff, which reports a file that is only a head in its own words.
    expect((await onlyShot(ctx, build)).diffError).not.toContain("too large");
  });
});
