import { describe, expect, test } from "vitest";
import { operatorHealth } from "./admin-health";
import { build, setup, shots } from "./compares-test-kit";

const now = new Date("2026-11-05T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(now.getTime() - ms);

const health = (db: Parameters<typeof operatorHealth>[0]) =>
  operatorHealth(db, {
    now,
    releaseSha: "abc1234",
    codeMigrations: [],
    dbBytes: { ok: false, why: "not read in this test" },
  });

describe("the operator page's compares (PS-336)", () => {
  test("per build: cache hits are counted apart and timed nowhere", async () => {
    const { db, projectId } = await setup();
    const done = await build(db, projectId, { createdAt: ago(HOUR), finishedAt: ago(HOUR - 1000) });
    const flying = await build(db, projectId, { status: "processing", createdAt: ago(MIN) });
    for (const id of [done, flying])
      await shots(db, id, [
        { measuredBy: "server", diffStatus: "unchanged", diffMs: 0 },
        { measuredBy: "server", diffStatus: "changed", diffMs: 40 },
      ]);
    const read = await health(db);
    const counted = { snapshots: 2, compared: 1, cacheHits: 1, times: { p50: 40, n: 1 } };
    expect(read.now.flying).toMatchObject([{ id: flying, ...counted }]);
    for (const w of read.windows) {
      expect(w).toMatchObject({ snapshots: 2, comparesRun: 1, cacheHits: 1 });
      expect(w.builds).toMatchObject([{ id: done, ...counted }]);
    }
  });

  test("a build whose run died is in its window's totals, as it is in its list", async () => {
    const { db, projectId } = await setup();
    const died = await build(db, projectId, {
      status: "errored",
      createdAt: ago(2 * HOUR),
      processingStartedAt: ago(HOUR),
    });
    await shots(db, died, [{ measuredBy: "ci", diffStatus: "changed" }]);
    for (const w of (await health(db)).windows) {
      expect(w).toMatchObject({ snapshots: 1, comparesRun: 1 });
      expect(w.builds).toMatchObject([{ id: died }]);
    }
  });

  test("the steps gain p99 at 100 builds and each window lists at most the newest 50", async () => {
    const { db, projectId } = await setup();
    for (let i = 0; i < 100; i++)
      await build(db, projectId, {
        diffMs: i + 1,
        createdAt: ago(HOUR),
        finishedAt: ago(HOUR - i * 1000),
      });
    for (const w of (await health(db)).windows) {
      expect(w.diff).toMatchObject({ n: 100, p99: 99 });
      expect(w.builds).toHaveLength(50);
    }
  });
});
