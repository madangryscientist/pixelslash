import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { ABANDONED_AFTER_MS, ABANDONED_REASON, sweepAbandoned } from "./abandoned";
import { createOrg, createProject } from "./orgs";
import { builds, snapshots } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

const NOW = new Date("2026-11-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SIX = ABANDONED_AFTER_MS;

async function setup(beforeQuery?: Parameters<typeof testDb>[0]) {
  const db = testDb(beforeQuery);
  const ada = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, ada.id, "Acme");
  const web = await createProject(db, ada.id, org.id, "web");
  const docs = await createProject(db, ada.id, org.id, "docs");
  return { db, web: web.id, docs: docs.id };
}
type Db = Awaited<ReturnType<typeof setup>>["db"];

/** A build `idleMs` old with the given fields, so the test says only what makes it idle or not. */
async function build(db: Db, projectId: string, over: Partial<typeof builds.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(builds).values({
    id,
    projectId,
    commitSha: "abc",
    branch: "feat/x",
    status: "uploading",
    createdAt: ago(SIX + HOUR),
    ...over,
  });
  return id;
}

async function shot(db: Db, buildId: string, createdAt: Date, name = "page") {
  await db.insert(snapshots).values({
    id: crypto.randomUUID(),
    buildId,
    name,
    platform: "web",
    browser: "chromium",
    viewport: "1280x720",
    theme: "light",
    envFingerprint: "fp",
    imageKey: `${name}.png`,
    createdAt,
  });
}

const read = async (db: Db, id: string) => {
  const [row] = await db.select().from(builds).where(eq(builds.id, id));
  if (!row) throw new Error("no such build");
  return row;
};
const sweep = (db: Db, extra: { limit?: number; projectId?: string } = {}) =>
  sweepAbandoned(db, { now: NOW, limit: extra.limit ?? 100, ...extra });

describe("sweepAbandoned", () => {
  test("an uploading build with no shots, idle past the limit, ends errored with the reason", async () => {
    const { db, web } = await setup();
    const id = await build(db, web);
    expect(await sweep(db)).toEqual([id]);
    const row = await read(db, id);
    expect(row.status).toBe("errored");
    expect(row.error).toBe(
      "no activity for 6 hours: the uploader or its run went away; send the build again",
    );
    expect(row.error).toBe(ABANDONED_REASON);
  });

  test("a processing build idle past the limit ends errored, whether or not it was ever claimed", async () => {
    const { db, web } = await setup();
    const claimed = await build(db, web, {
      status: "processing",
      processingStartedAt: ago(SIX + 30 * 60 * 1000),
    });
    const unclaimed = await build(db, web, { status: "processing", processingStartedAt: null });
    expect((await sweep(db)).toSorted()).toEqual([claimed, unclaimed].toSorted());
    expect((await read(db, claimed)).status).toBe("errored");
    expect((await read(db, unclaimed)).status).toBe("errored");
  });

  test("an old build whose newest shot is inside the limit is untouched", async () => {
    const { db, web } = await setup();
    const id = await build(db, web);
    await shot(db, id, ago(SIX + 2 * HOUR), "old");
    await shot(db, id, ago(HOUR), "new");
    expect(await sweep(db)).toEqual([]);
    expect((await read(db, id)).status).toBe("uploading");
  });

  test("an old build whose processingStartedAt is inside the limit is untouched", async () => {
    const { db, web } = await setup();
    const id = await build(db, web, { status: "processing", processingStartedAt: ago(HOUR) });
    expect(await sweep(db)).toEqual([]);
    expect((await read(db, id)).status).toBe("processing");
  });

  test("a build made inside the limit is untouched", async () => {
    const { db, web } = await setup();
    const id = await build(db, web, { createdAt: ago(SIX - HOUR) });
    expect(await sweep(db)).toEqual([]);
    expect((await read(db, id)).status).toBe("uploading");
  });

  test.each(["passed", "changes", "failed", "errored"] as const)(
    "a %s build of any age is untouched",
    async (status) => {
      const { db, web } = await setup();
      const id = await build(db, web, {
        status,
        error: status === "errored" ? "boom" : null,
        createdAt: ago(400 * 24 * HOUR),
      });
      expect(await sweep(db)).toEqual([]);
      const row = await read(db, id);
      expect(row.status).toBe(status);
      expect(row.error).toBe(status === "errored" ? "boom" : null);
    },
  );

  test("limit is honoured, oldest first", async () => {
    const { db, web } = await setup();
    const newest = await build(db, web, { createdAt: ago(SIX + HOUR) });
    const oldest = await build(db, web, { createdAt: ago(SIX + 30 * HOUR) });
    const middle = await build(db, web, { createdAt: ago(SIX + 10 * HOUR) });
    expect(await sweep(db, { limit: 2 })).toEqual([oldest, middle]);
    expect((await read(db, newest)).status).toBe("uploading");
    expect(await sweep(db, { limit: 2 })).toEqual([newest]);
  });

  test("a build that finalised after it was read is left as it is", async () => {
    // The sweep reads `processing`; the run finishes before the sweep's update. The update holds
    // the status it read, so the verdict stays.
    let finalises: string | null = null;
    const { db, web } = await setup((query, exec) => {
      if (finalises && query.startsWith('update "builds"')) {
        exec(`update builds set status = 'passed' where id = '${finalises}'`);
        finalises = null;
      }
    });
    const id = await build(db, web, { status: "processing" });
    finalises = id;
    expect(await sweep(db)).toEqual([]);
    expect((await read(db, id)).status).toBe("passed");
    expect((await read(db, id)).error).toBeNull();
  });

  test("it writes only status and error: times, timings and shots stay", async () => {
    const { db, web } = await setup();
    const timings = { totalMs: 123, shots: [] };
    const id = await build(db, web, {
      status: "processing",
      processingStartedAt: ago(SIX + HOUR),
      finishedAt: null,
      queueMs: 11,
      diffMs: 22,
      timings,
    });
    await shot(db, id, ago(SIX + 3 * HOUR), "a");
    await shot(db, id, ago(SIX + 2 * HOUR), "b");
    const before = await read(db, id);
    const shotsBefore = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(await sweep(db)).toEqual([id]);
    const after = await read(db, id);
    expect({ ...after, status: before.status, error: before.error }).toEqual(before);
    expect(after.finishedAt).toBeNull();
    expect(after.queueMs).toBe(11);
    expect(after.diffMs).toBe(22);
    expect(after.timings).toEqual(before.timings);
    const shotsAfter = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(shotsAfter).toEqual(shotsBefore);
    expect(shotsAfter).toHaveLength(2);
  });
});
