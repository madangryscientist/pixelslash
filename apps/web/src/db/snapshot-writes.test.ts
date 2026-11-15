import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { context, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { Db } from "./db";
import { snapshots } from "./schema";
import { SnapshotWrites, WRITES_PER_BATCH, changedFields } from "./snapshot-writes";

/** `db`, with the size of every batch it is sent recorded; `fail` makes each batch throw. */
function counted(db: Db, fail = false) {
  const batches: number[] = [];
  const spy = new Proxy(db, {
    get(target, prop) {
      if (prop !== "batch") return Reflect.get(target, prop, target);
      const batch: Db["batch"] = async (items) => {
        batches.push(items.length);
        if (fail) throw new Error("the batch failed");
        return target.batch(items);
      };
      return batch;
    },
  });
  return { db: spy, batches };
}

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
// Not white's bytes, so it is measured (identical bytes settle without a diff), and still unchanged.
const whiteAgain = shot({ blocks: [{ x: 1, y: 1, w: 1, h: 1, rgb: [254, 254, 254] }] });

describe("a diff run's row writes", () => {
  test("go in batches, not one statement per shot, and store what one at a time stored", async () => {
    const ctx = await context();
    const n = 2 * WRITES_PER_BATCH + 5;
    const names = Array.from({ length: n }, (_, i) => `shot-${i}`);
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: names.map((name) => ({ name, png: white })),
    });
    const { db, batches } = counted(ctx.db);
    const build = await upload(
      ctx,
      {
        branch: "feat/a",
        commit: sha(2),
        mergeBase: sha(1),
        shots: names.map((name, i) => ({ name, png: i % 2 ? red : whiteAgain })),
      },
      { db },
    );

    expect(build.status).toBe("changes");
    // Each shot's result, its resolved options in the same statement, and its result against
    // main: two writes a shot, in full batches and one tail.
    expect(batches.every((size) => size <= WRITES_PER_BATCH)).toBe(true);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(2 * n);
    expect(batches.length).toBeLessThanOrEqual(Math.ceil((2 * n) / WRITES_PER_BATCH) + 1);
    const stored = await rows(ctx, build);
    expect(stored.filter((r) => r.diffStatus === "changed")).toHaveLength(Math.floor(n / 2));
    expect(stored.filter((r) => r.diffStatus === "unchanged")).toHaveLength(Math.ceil(n / 2));
    expect(stored.every((r) => r.mainDiffStatus === r.diffStatus)).toBe(true);
  });

  test("what waits on a row runs after its batch is written, and not when the batch fails", async () => {
    const ctx = await context();
    const build = await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "a", png: white }],
    });
    const [row] = await rows(ctx, build);
    if (!row) throw new Error("no row");
    const errorOf = async () =>
      (await ctx.db.select().from(snapshots).where(eq(snapshots.id, row.id)))[0]?.diffError;

    const seen: (string | null | undefined)[] = [];
    const writes = new SnapshotWrites(ctx.db);
    writes.update(row, { diffError: "written" }, async () => void seen.push(await errorOf()));
    expect(seen).toEqual([]);
    await writes.flush();
    expect(seen).toEqual(["written"]);

    const failing = new SnapshotWrites(counted(ctx.db, true).db);
    failing.update(row, { diffError: "never" }, async () => void seen.push("ran"));
    await expect(failing.flush()).rejects.toThrow(/the batch failed/);
    expect(seen).toEqual(["written"]);
    expect(await errorOf()).toBe("written");
  });

  test("a write that leaves a row as it was sends nothing, and one sets only what moves", async () => {
    const ctx = await context();
    const build = await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "a", png: white }],
    });
    const [row] = await rows(ctx, build);
    if (!row) throw new Error("no row");
    const { db, batches } = counted(ctx.db);
    const writes = new SnapshotWrites(db);

    // The own diff's fields as they are stored: nothing moves, so no statement.
    writes.update(row, {
      diffStatus: row.diffStatus,
      diffResult: row.diffResult === null ? null : structuredClone(row.diffResult),
      baselineKey: row.baselineKey,
      carriedFrom: null,
      diffError: null,
      createdAt: new Date(row.createdAt.getTime()),
    });
    await writes.settle();
    expect(batches).toEqual([]);

    // A field held for the result and the result's own go in one statement, of the moved fields.
    expect(changedFields(row, { diffError: "moved", carriedFrom: null, diffMs: 7 })).toEqual({
      diffError: "moved",
      diffMs: 7,
    });
    const folded = new SnapshotWrites(db);
    folded.hold(row, { aiError: "held", carriedFrom: null });
    folded.update(row, { diffError: "moved", carriedFrom: null });
    await folded.flush();
    expect(batches).toEqual([1]);

    // A hold that no result follows is written when the run settles, not at a flush.
    const alone = new SnapshotWrites(db);
    alone.hold(row, { diffError: "held" });
    await alone.flush();
    expect(batches).toEqual([1]);
    await alone.settle();
    expect(batches).toEqual([1, 1]);
    const [stored] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, row.id));
    expect([stored?.diffError, stored?.aiError]).toEqual(["held", "held"]);
  });
});
