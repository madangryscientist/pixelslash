import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { STALE_PROCESSING_MS } from "#/diff/claim";
import { operatorHealth, type HealthInputs } from "./admin-health";
import { createOrg, createProject } from "./orgs";
import { builds, orgs, snapshots } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

const now = new Date("2026-11-05T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const inputs = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now,
  releaseSha: "abc1234",
  codeMigrations: [],
  dbBytes: { ok: false, why: "not read in this test" },
  ...over,
});

const create = (db: ReturnType<typeof testDb>) =>
  db.run(
    sql`create table d1_migrations (id integer primary key autoincrement, name text unique, applied_at text)`,
  );
const apply = (db: ReturnType<typeof testDb>, name: string) =>
  db.run(sql`insert into d1_migrations (name, applied_at) values (${name}, 'now')`);

async function setup() {
  const db = testDb();
  const ada = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, ada.id, "Acme");
  const project = await createProject(db, ada.id, org.id, "web");
  return { db, org, project };
}

type Row = Partial<typeof builds.$inferInsert> & { projectId: string };

async function build(db: ReturnType<typeof testDb>, row: Row) {
  const id = crypto.randomUUID();
  await db
    .insert(builds)
    .values({ id, commitSha: "abc", branch: "main", status: "passed", ...row });
  return id;
}

async function shot(
  db: ReturnType<typeof testDb>,
  buildId: string,
  over: Partial<typeof snapshots.$inferInsert> = {},
) {
  await db.insert(snapshots).values({
    id: crypto.randomUUID(),
    buildId,
    name: `page-${crypto.randomUUID()}`,
    platform: "web",
    browser: "chromium",
    viewport: "1280x720",
    theme: "light",
    envFingerprint: "fp",
    imageKey: "k.png",
    ...over,
  });
}

const ago = (ms: number) => new Date(now.getTime() - ms);

describe("operatorHealth", () => {
  test("an empty database: zero counts, no times, nothing stuck, and what cannot be read says why", async () => {
    const { db } = await setup();
    const health = await operatorHealth(db, inputs());
    expect(health.now).toMatchObject({
      byStatus: {},
      inFlight: 0,
      oldestInFlight: null,
      stuckTotal: 0,
      stuck: [],
    });
    for (const w of health.windows) {
      expect(w).toMatchObject({
        finished: 0,
        rerun: 0,
        comparesRun: 0,
        explainFailures: 0,
        errored: [],
      });
      expect(w.outcomes).toEqual({ passed: 0, changes: 0, failed: 0, errored: 0 });
      expect([w.wall, w.queue, w.diff, w.explain, w.summary]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    }
    expect(health.storage.rows).toEqual([
      { table: "builds", count: 0 },
      { table: "snapshots", count: 0 },
      { table: "flakes", count: 0 },
      { table: "flags", count: 0 },
    ]);
    expect(health.storage.r2.ok).toBe(false);
    expect(health.storage.dbBytes).toEqual({ ok: false, why: "not read in this test" });
    expect(health.summaryFailures.ok).toBe(false);
    expect(health.windowsCapped).toBe(false);
  });

  test("one finished build: outcome, wall time, the step times and the shots it measured", async () => {
    const { db, project } = await setup();
    const id = await build(db, {
      projectId: project.id,
      status: "changes",
      createdAt: ago(2 * HOUR),
      finishedAt: ago(2 * HOUR - 90_000),
      queueMs: 1000,
      diffMs: 4000,
      explainMs: 2000,
      summaryMs: 500,
    });
    await shot(db, id, { diffMs: 120, measuredBy: "server" });
    await shot(db, id, { diffMs: 80, measuredBy: "server", aiError: "model timed out" });
    await shot(db, id, { measuredBy: "ci" });
    await shot(db, id);
    const health = await operatorHealth(db, inputs());
    for (const w of health.windows) {
      expect(w.finished).toBe(1);
      expect(w.outcomes).toEqual({ passed: 0, changes: 1, failed: 0, errored: 0 });
      expect(w.wall).toMatchObject({ p50: 90_000, p95: 90_000, n: 1 });
      expect([w.queue?.p50, w.diff?.p50, w.explain?.p50, w.summary?.p50]).toEqual([
        1000, 4000, 2000, 500,
      ]);
      expect([w.comparesRun, w.explainFailures]).toEqual([3, 1]);
    }
    expect(health.now.byStatus).toEqual({ changes: 1 });
    expect(health.storage.rows.find((r) => r.table === "snapshots")?.count).toBe(4);
  });

  test("a build that finished 3 days ago is in the 7-day window and not the 24-hour one", async () => {
    const { db, project } = await setup();
    await build(db, {
      projectId: project.id,
      createdAt: ago(73 * HOUR),
      finishedAt: ago(72 * HOUR),
    });
    const [day, week] = (await operatorHealth(db, inputs())).windows;
    expect(day?.finished).toBe(0);
    expect(week?.finished).toBe(1);
  });

  test("a rerun is counted as finished but left out of the times", async () => {
    const { db, project } = await setup();
    await build(db, {
      projectId: project.id,
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 1000),
      diffMs: 100,
    });
    await build(db, {
      projectId: project.id,
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 60_000),
      diffMs: 99_999,
      rerun: true,
    });
    const [day] = (await operatorHealth(db, inputs())).windows;
    expect(day).toMatchObject({ finished: 2, rerun: 1 });
    expect(day?.diff).toMatchObject({ n: 1, max: 100 });
  });

  test("a stuck build is listed with how long it has been stuck; a fresh one in flight is not", async () => {
    const { db, project } = await setup();
    const stuck = await build(db, {
      projectId: project.id,
      status: "processing",
      createdAt: ago(HOUR),
      processingStartedAt: ago(STALE_PROCESSING_MS + 10 * MIN),
    });
    await build(db, {
      projectId: project.id,
      status: "processing",
      createdAt: ago(2 * MIN),
      processingStartedAt: ago(MIN),
    });
    const { now: current } = await operatorHealth(db, inputs());
    expect(current.byStatus).toEqual({ processing: 2 });
    expect(current.inFlight).toBe(2);
    expect(current.oldestInFlight).toMatchObject({ id: stuck, ageMs: HOUR });
    expect(current.stuckTotal).toBe(1);
    expect(current.stuck).toHaveLength(1);
    expect(current.stuck[0]).toMatchObject({ id: stuck, stuckMs: STALE_PROCESSING_MS + 10 * MIN });
  });

  test("errored builds are grouped by the first words of their error, one build per reason", async () => {
    const { db, project } = await setup();
    const reasons = [
      "the run measuring this build died; re-run the CI job",
      "baseline image missing: builds/1/a.png",
      "one two three four five six seven eight",
      null,
    ];
    for (const error of reasons)
      await build(db, {
        projectId: project.id,
        status: "errored",
        error,
        createdAt: ago(HOUR),
        finishedAt: ago(HOUR - 1000),
      });
    await build(db, {
      projectId: project.id,
      status: "errored",
      error: "baseline image missing: builds/2/b.png",
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 1000),
    });
    const [day] = (await operatorHealth(db, inputs())).windows;
    expect(day?.outcomes.errored).toBe(5);
    expect(day?.errored).toEqual([
      { reason: "baseline image missing", count: 2 },
      { reason: "(no reason recorded)", count: 1 },
      { reason: "one two three four five six", count: 1 },
      { reason: "the run measuring this build died", count: 1 },
    ]);
  });

  test("a CI build whose run died has no finished_at: it is counted as errored, placed by its run start, and not timed", async () => {
    const { db, project } = await setup();
    await build(db, {
      projectId: project.id,
      status: "errored",
      error: "the run measuring this build died; re-run the CI job",
      createdAt: ago(3 * HOUR),
      processingStartedAt: ago(2 * HOUR),
    });
    const [day, week] = (await operatorHealth(db, inputs())).windows;
    for (const w of [day, week]) {
      expect(w?.finished).toBe(1);
      expect(w?.outcomes.errored).toBe(1);
      expect(w?.wall).toBeNull();
    }
  });

  test("a smoke org's builds are not counted anywhere", async () => {
    const { db, org, project } = await setup();
    await db
      .update(orgs)
      .set({ isSmoke: true })
      .where(sql`${orgs.id} = ${org.id}`);
    await build(db, {
      projectId: project.id,
      status: "processing",
      processingStartedAt: ago(HOUR),
    });
    const done = await build(db, {
      projectId: project.id,
      status: "errored",
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR - 1000),
    });
    await shot(db, done, { measuredBy: "server", aiError: "model timed out" });
    await build(db, {
      projectId: project.id,
      status: "errored",
      createdAt: ago(3 * HOUR),
      processingStartedAt: ago(2 * HOUR),
    });
    const health = await operatorHealth(db, inputs());
    expect(health.now).toMatchObject({ byStatus: {}, oldestInFlight: null, stuckTotal: 0 });
    for (const w of health.windows)
      expect(w).toMatchObject({ finished: 0, errored: [], comparesRun: 0, explainFailures: 0 });
  });

  describe("deployment", () => {
    test("an empty sha is unavailable, never blank", async () => {
      const { db } = await setup();
      expect((await operatorHealth(db, inputs())).deployment.sha).toEqual({
        ok: true,
        value: "abc1234",
      });
      expect((await operatorHealth(db, inputs({ releaseSha: "" }))).deployment.sha.ok).toBe(false);
    });

    test("no d1_migrations table: every migration reading says why, and none is a guess", async () => {
      const { db } = await setup();
      const { deployment } = await operatorHealth(db, inputs({ codeMigrations: ["0000_a.sql"] }));
      expect(deployment.latestApplied.ok).toBe(false);
      expect(deployment.unapplied.ok).toBe(false);
    });

    test("code migrations the database has not applied are listed, and the newest applied is named", async () => {
      const { db } = await setup();
      await create(db);
      await apply(db, "0000_a.sql");
      await apply(db, "0001_b.sql");
      const { deployment } = await operatorHealth(
        db,
        inputs({ codeMigrations: ["0000_a.sql", "0001_b.sql", "0002_c.sql", "0003_d.sql"] }),
      );
      expect(deployment.latestApplied).toEqual({ ok: true, value: "0001_b.sql" });
      expect(deployment.unapplied).toEqual({ ok: true, value: ["0002_c.sql", "0003_d.sql"] });
    });
  });
});
