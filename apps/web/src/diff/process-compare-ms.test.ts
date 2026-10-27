import { diffPngs } from "@pixelslash/engine/diff";
import { describe, expect, test } from "vitest";
import type { BlobStore } from "#/storage/blobs";
import { processBuild } from "./process";
import { rerunShots } from "./rerun";
import { type Ctx, context, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** Each shot's compare time, `snapshots.diff_ms` (PS-233): written for the shots a run measured. */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const NAMES = ["a", "b", "c", "d"];

const failing: typeof diffPngs = () => {
  throw new Error("PNG does not decode");
};

/** A clock only a blob write advances, by `cost` ms: one changed shot's compare then takes `cost`. */
function timed(ctx: Ctx, cost: number) {
  let t = 0;
  const blobs: BlobStore = {
    ...ctx.scoped,
    put: async (key, body, type) => {
      t += cost;
      await ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, now: () => t };
}

const byName = async (ctx: Ctx, build: Parameters<typeof rows>[1]) =>
  Object.fromEntries((await rows(ctx, build)).map((r) => [r.name, r.diffMs]));

describe("per-shot compare time", () => {
  test("a measured shot stores its compare time; a new one stores none", async () => {
    const ctx = await context();
    const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    expect((await onlyShot(ctx, main)).diffMs).toBeNull();
    const clock = timed(ctx, 400);
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      clock,
    );
    expect(await onlyShot(ctx, build)).toMatchObject({ diffStatus: "changed", diffMs: 400 });
  });

  test("a shot whose diff failed was never measured, and stays NULL", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      { diff: failing },
    );
    expect(build.status).toBe("errored");
    expect((await onlyShot(ctx, build)).diffMs).toBeNull();
  });

  test("a resumed run writes the shots it measured and leaves the others alone", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: NAMES.map((name) => ({ name, png: white })),
    });
    // 10 s a shot against a 25 s budget: the first run measures two and stops.
    const first = timed(ctx, 10_000);
    const errored = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: NAMES.map((name) => ({ name, png: red })),
      },
      first,
    );
    expect(errored.status).toBe("errored");
    const before = await byName(ctx, errored);
    expect(Object.values(before).filter((ms) => ms === 10_000)).toHaveLength(2);
    expect(Object.values(before).filter((ms) => ms === null)).toHaveLength(2);
    const second = timed(ctx, 7);
    await processBuild({ db: ctx.db, blobs: second.blobs, now: second.now }, errored);
    const after = await byName(ctx, errored);
    for (const name of NAMES) expect(after[name]).toBe(before[name] === null ? 7 : 10_000);
  });

  test("a re-run of one shot rewrites that shot's time and no other", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: ["a", "b"].map((name) => ({ name, png: white })),
    });
    const build = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: ["a", "b"].map((name) => ({ name, png: red })),
      },
      timed(ctx, 300),
    );
    expect(await byName(ctx, build)).toEqual({ a: 300, b: 300 });
    const picked = (await rows(ctx, build)).find((r) => r.name === "a");
    const clock = timed(ctx, 50);
    await rerunShots({ db: ctx.db, blobs: clock.blobs, now: clock.now }, build, picked?.id ?? "");
    expect(await byName(ctx, build)).toEqual({ a: 50, b: 300 });
  });
});
