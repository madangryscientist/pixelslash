import { describe, expect, test } from "vitest";
import { operatorHealth } from "./admin-health";
import { P99_MIN_COMPARES, percentile } from "#/lib/timings";
import { baseline, build, setup, shots } from "./compares-test-kit";

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

const server = (diffMs: number | null) =>
  ({ measuredBy: "server", diffStatus: "changed", diffMs }) as const;

async function windowOf(db: Parameters<typeof operatorHealth>[0], key = "24h") {
  const w = (await health(db)).windows.find((x) => x.key === key);
  if (!w) throw new Error("no window");
  return w.figures;
}

async function ended(
  db: Awaited<ReturnType<typeof setup>>["db"],
  projectId: string,
  counts: number[],
  over: Partial<Parameters<typeof build>[2]> = {},
) {
  for (const count of counts) {
    const id = await build(db, projectId, {
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 1000),
      ...over,
    });
    await shots(
      db,
      id,
      Array.from({ length: count }, () => server(10)),
    );
  }
}

/** `n` builds of one held shot each. */
const builds = (n: number) => Array.from({ length: n }, () => 1);

describe("the operator page's window figures (PS-342)", () => {
  test("cache hits are snapshots in a build and in no time", async () => {
    const { db, projectId } = await setup();
    const same = await baseline(db, projectId, "sha-a");
    const id = await build(db, projectId, { createdAt: ago(HOUR), finishedAt: ago(HOUR - 1000) });
    const unchanged = { measuredBy: "server", diffStatus: "unchanged" } as const;
    await shots(db, id, [
      { ...unchanged, diffMs: 0, imageSha256: "sha-a", baselineSnapshotId: same },
      { ...unchanged, diffMs: null, imageSha256: "sha-a", baselineSnapshotId: same },
      { ...unchanged, diffMs: 1, imageSha256: "sha-a", baselineSnapshotId: same },
      server(40),
      { diffStatus: "removed" },
    ]);
    const figures = await windowOf(db);
    expect(figures.perBuild).toMatchObject({ n: 1, p50: 4, max: 4 });
    expect(figures.perSnapshot).toMatchObject({ n: 1, p50: 40, max: 40 });
  });

  test("nearest rank over an odd and an even count picks a stored value", async () => {
    const odd = await setup();
    await ended(odd.db, odd.projectId, [5, 1, 3]);
    expect((await windowOf(odd.db)).perBuild).toMatchObject({ p50: 3, p95: 5, max: 5, n: 3 });
    const even = await setup();
    await ended(even.db, even.projectId, [4, 1, 3, 2]);
    expect((await windowOf(even.db)).perBuild).toMatchObject({ p50: 2, p95: 4, n: 4 });
  });
  test("snapshots per build gains p95 at 20 builds and p99 at 100, a dash one below", async () => {
    const { db, projectId } = await setup();
    await ended(db, projectId, builds(19));
    expect((await windowOf(db)).perBuild).toMatchObject({ n: 19, tail: "max", p99: null });
    await ended(db, projectId, builds(1));
    expect((await windowOf(db)).perBuild).toMatchObject({ n: 20, tail: "p95", p95: 1, p99: null });
    await ended(db, projectId, builds(79));
    expect((await windowOf(db)).perBuild).toMatchObject({ n: 99, p99: null });
    await ended(db, projectId, builds(1));
    expect((await windowOf(db)).perBuild).toMatchObject({ n: 100, p50: 1, p95: 1, p99: 1 });
  });

  test("time per snapshot gains p99 at 500 compares, a dash one below, and matches `percentile`", async () => {
    const { db, projectId } = await setup();
    const times = Array.from({ length: P99_MIN_COMPARES }, (_, i) => ((i + 1) * 7919) % 10_007);
    const a = await build(db, projectId, { createdAt: ago(HOUR), finishedAt: ago(HOUR - 1000) });
    await shots(
      db,
      a,
      times.slice(0, 300).map((ms) => server(ms)),
    );
    const b = await build(db, projectId, { createdAt: ago(HOUR), finishedAt: ago(HOUR - 2000) });
    await shots(
      db,
      b,
      times.slice(300, P99_MIN_COMPARES - 1).map((ms) => server(ms)),
    );
    expect((await windowOf(db)).perSnapshot).toMatchObject({ n: P99_MIN_COMPARES - 1, p99: null });
    await shots(db, b, [server(times[P99_MIN_COMPARES - 1] ?? 0)]);
    const sorted = times.toSorted((x, y) => x - y);
    expect((await windowOf(db)).perSnapshot).toEqual({
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1),
      n: P99_MIN_COMPARES,
      tail: "p95",
    });
  });

  test("a window holds the builds that ended in it, and a CI compare is no server time", async () => {
    const { db, projectId } = await setup();
    const old = await build(db, projectId, {
      createdAt: ago(48 * HOUR),
      finishedAt: ago(47 * HOUR),
    });
    await shots(db, old, [server(900), server(901)]);
    const recent = await build(db, projectId, {
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 1000),
    });
    await shots(db, recent, [server(5), { measuredBy: "ci", diffStatus: "changed", diffMs: 700 }]);
    const read = await health(db);
    expect(read.windows.map((w) => w.figures.perBuild?.n)).toEqual([1, 2]);
    expect(read.windows[0]?.figures.perSnapshot).toMatchObject({ n: 1, max: 5 });
    expect(read.windows[1]?.figures.perSnapshot).toMatchObject({ n: 3, max: 901 });
    expect(read.windows[0]?.figures.perBuild).toMatchObject({ p50: 2 });
  });

  test("a window with no build has no figures, not zeros", async () => {
    const { db } = await setup();
    expect(await windowOf(db)).toEqual({ perBuild: null, perSnapshot: null });
  });
});
