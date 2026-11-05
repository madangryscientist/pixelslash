import { describe, expect, test } from "vitest";
import { P99_MIN_COMPARES, percentile } from "#/lib/timings";
import { compareMsOf, countRun } from "#/lib/run-metrics";
import { buildCompares } from "./build-compares";
import { type ShotRow, type TestDb, baseline, build, setup, shots } from "./compares-test-kit";
import { buildView } from "./review";

/** A shot the server compared. */
const ran = (diffMs: number | null): ShotRow => ({
  diffMs,
  measuredBy: "server",
  diffStatus: "changed",
});

const scattered = (n: number) => Array.from({ length: n }, (_, i) => (i * 7919) % 10_007);

async function one(db: TestDb, id: string) {
  const [result] = await buildCompares(db, [{ id, status: "passed" }]);
  if (!result) throw new Error("no row");
  return result;
}

describe("buildCompares", () => {
  test("nearest rank over an odd count, as `percentile` reads it", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [50, 10, 40, 20, 30].map(ran));
    expect((await one(db, id)).times).toEqual({
      p50: 30,
      p95: 50,
      p99: null,
      max: 50,
      n: 5,
      tail: "max",
    });
  });

  test("nearest rank over an even count picks a stored value, never a midpoint", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [10, 20, 30, 40].map(ran));
    expect((await one(db, id)).times).toMatchObject({ p50: 20, p95: 40, n: 4 });
  });

  test("a null time is in the counts and not in the sample", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [ran(null), ran(10), ran(30)]);
    const result = await one(db, id);
    expect(result).toMatchObject({ snapshots: 3, compared: 3, cacheHits: 0 });
    expect(result.times).toMatchObject({ n: 2, p50: 10 });
  });

  test("all times null is no times, not zero", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [ran(null), ran(null)]);
    expect(await one(db, id)).toMatchObject({ snapshots: 2, compared: 2, times: null });
  });

  test("one build among others keeps its own sample", async () => {
    const { db, projectId } = await setup();
    const a = await build(db, projectId);
    const b = await build(db, projectId);
    await shots(db, a, [ran(5)]);
    await shots(db, b, [ran(500), ran(700)]);
    const [first, second] = await buildCompares(db, [
      { id: b, status: "passed" },
      { id: a, status: "errored" },
    ]);
    expect(first).toMatchObject({ id: b, status: "passed", times: { p50: 500, max: 700, n: 2 } });
    expect(second).toMatchObject({ id: a, status: "errored", times: { p50: 5, max: 5, n: 1 } });
  });

  test("p99 is held back until its gate and matches `percentile` from there", async () => {
    const { db, projectId } = await setup();
    const under = await build(db, projectId);
    await shots(db, under, scattered(P99_MIN_COMPARES - 1).map(ran));
    expect((await one(db, under)).times?.p99).toBeNull();
    const at = await build(db, projectId);
    const sample = scattered(P99_MIN_COMPARES + 1);
    await shots(db, at, sample.map(ran));
    const sorted = sample.toSorted((a, b) => a - b);
    expect((await one(db, at)).times).toMatchObject({
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      n: sample.length,
    });
  });

  test("a cache hit is a snapshot, no compare and no time, in all three stored forms", async () => {
    const { db, projectId } = await setup();
    const same = await baseline(db, projectId, "sha-a");
    const unchanged = { measuredBy: "server", diffStatus: "unchanged" } as const;
    const id = await build(db, projectId);
    await shots(db, id, [
      // Stored by `timedComparer` until PS-336: the same bytes, with a 0.
      { ...unchanged, diffMs: 0, imageSha256: "sha-a", baselineSnapshotId: same },
      // Older than the timing, and what is stored from PS-336 on.
      { ...unchanged, diffMs: null, imageSha256: "sha-a", baselineSnapshotId: same },
      // A clock tick on the same path: a time, and still no compare ran.
      { ...unchanged, diffMs: 1, imageSha256: "sha-a", baselineSnapshotId: same },
      // A real compare that found no change: other bytes, its own time.
      { ...unchanged, diffMs: 40, imageSha256: "sha-b", baselineSnapshotId: same },
    ]);
    const result = await one(db, id);
    expect(result).toMatchObject({ snapshots: 4, compared: 1, cacheHits: 3 });
    expect(result.times).toMatchObject({ p50: 40, n: 1 });
  });

  test("a build of cache hits only has counts and no times", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [{ measuredBy: "server", diffStatus: "unchanged", diffMs: 0 }]);
    expect(await one(db, id)).toMatchObject({
      snapshots: 1,
      compared: 0,
      cacheHits: 1,
      times: null,
    });
  });

  test("a removed marker is no snapshot, and a CI result is compared and not timed here", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [
      { diffStatus: "removed" },
      { measuredBy: "ci", diffStatus: "changed", diffMs: 900 },
      ran(10),
    ]);
    expect(await one(db, id)).toMatchObject({
      snapshots: 2,
      compared: 2,
      times: { p50: 10, n: 1 },
    });
  });

  test("a build CI measured reads the times its CLI sent, as the card does", async () => {
    const { db, projectId } = await setup();
    const timings = {
      totalMs: 100,
      shots: [
        { name: "a", diffMs: 30 },
        { name: "b", diffMs: 10 },
        { name: "c" },
        { name: "new", diffMs: 0 },
      ],
    };
    const id = await build(db, projectId, { timings });
    await shots(db, id, [{ measuredBy: "ci", diffStatus: "changed" }]);
    expect(await one(db, id)).toMatchObject({ compared: 1, times: { p50: 10, max: 30, n: 2 } });
  });

  test("the same bytes measured by CI are a compare: the CLI has no shortcut and timed it", async () => {
    const { db, projectId } = await setup();
    const same = await baseline(db, projectId, "sha-ci");
    const id = await build(db, projectId);
    await shots(db, id, [
      {
        measuredBy: "ci",
        diffStatus: "unchanged",
        imageSha256: "sha-ci",
        baselineSnapshotId: same,
      },
    ]);
    expect(await one(db, id)).toMatchObject({ snapshots: 1, compared: 1, cacheHits: 0 });
  });

  test("the card's JS reads the same rows as the page's SQL", async () => {
    const { db, projectId } = await setup();
    const same = await baseline(db, projectId, "sha-a");
    const id = await build(db, projectId);
    await shots(db, id, [
      { measuredBy: "server", diffStatus: "unchanged", diffMs: 0 },
      {
        measuredBy: "server",
        diffStatus: "unchanged",
        imageSha256: "sha-a",
        baselineSnapshotId: same,
      },
      { measuredBy: "server", diffStatus: "unchanged", diffMs: 12 },
      ran(30),
      { diffStatus: "new" },
    ]);
    const { snapshots: rows } = await buildView(db, projectId, id);
    const counted = countRun({ branch: "x" }, rows, "main");
    const sql = await one(db, id);
    expect(sql.snapshots).toBe(counted.shots);
    expect(sql.compared).toBe(counted.compares.server + counted.compares.ci);
    expect(sql.cacheHits).toBe(counted.cacheHits);
    expect(sql.times?.n).toBe(rows.flatMap((r) => compareMsOf(r) ?? []).length);
  });

  test("a result nobody is recorded as measuring, or a re-run cleared, is no compare", async () => {
    const { db, projectId } = await setup();
    const id = await build(db, projectId);
    await shots(db, id, [
      ran(10),
      { measuredBy: "server", diffMs: 20, diffStatus: null },
      { diffStatus: "unchanged" },
    ]);
    expect(await one(db, id)).toMatchObject({
      snapshots: 3,
      compared: 1,
      times: { n: 1, max: 10 },
    });
  });
});
