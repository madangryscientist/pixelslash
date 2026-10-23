import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { NotFoundError } from "./db";
import { createOrg, createProject } from "./orgs";
import { builds, orgs } from "./schema";
import { testDb } from "./test-db";
import { TIMINGS_WINDOW_MS, orgTimings } from "./timings-stats";
import { signInGithubUser } from "./users";

const now = new Date("2026-10-24T12:00:00Z");
const profile = (githubId: number, login: string) => ({
  githubId,
  login,
  name: null,
  avatarUrl: null,
});

async function setup() {
  const db = testDb();
  const ada = await signInGithubUser(db, profile(1, "ada"));
  const org = await createOrg(db, ada.id, "Acme");
  const web = await createProject(db, ada.id, org.id, "web");
  const docs = await createProject(db, ada.id, org.id, "docs");
  return { db, ada, org, web, docs };
}

/** A finished build of the project: `diffMs`, and a total of `total` ms, `ago` ms before `now`. */
async function finished(
  db: ReturnType<typeof testDb>,
  projectId: string,
  {
    diffMs,
    ago = 1000,
    total = diffMs,
    rerun = false,
  }: { diffMs: number; ago?: number; total?: number; rerun?: boolean },
) {
  const end = new Date(now.getTime() - ago);
  await db.insert(builds).values({
    id: crypto.randomUUID(),
    projectId,
    commitSha: "abc",
    branch: "main",
    status: "passed",
    diffMs,
    rerun,
    processingStartedAt: new Date(end.getTime() - total),
    finishedAt: end,
  });
}

describe("orgTimings", () => {
  test("lists every project with p50/p95 of its builds, a project without builds has none", async () => {
    const { db, ada, org, web, docs } = await setup();
    for (const diffMs of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
      await finished(db, web.id, { diffMs });
    const result = await orgTimings(db, ada.id, org.id, now);
    expect(result.map((p) => p.name)).toEqual(["docs", "web"]);
    const [emptyDocs, fullWeb] = result;
    expect(emptyDocs).toMatchObject({ projectId: docs.id, builds: 0 });
    expect(Object.values(emptyDocs?.steps ?? {})).toEqual([null, null, null, null, null]);
    expect(fullWeb?.builds).toBe(10);
    expect(fullWeb?.steps.diff).toEqual({ p50: 500, p95: 1000, n: 10 });
    expect(fullWeb?.steps.queue).toBeNull();
  });

  test("builds older than 30 days and builds still running are left out", async () => {
    const { db, ada, org, web } = await setup();
    await finished(db, web.id, { diffMs: 100 });
    await finished(db, web.id, { diffMs: 9_999, ago: TIMINGS_WINDOW_MS + 1 });
    await db.insert(builds).values({
      id: crypto.randomUUID(),
      projectId: web.id,
      commitSha: "def",
      branch: "main",
      status: "processing",
      diffMs: 8_888,
    });
    const [, result] = await orgTimings(db, ada.id, org.id, now);
    expect(result?.builds).toBe(1);
    expect(result?.steps.diff).toEqual({ p50: 100, p95: 100, n: 1 });
  });

  test("a build that took a second run is left out: it holds its last run's numbers only", async () => {
    const { db, ada, org, web } = await setup();
    await finished(db, web.id, { diffMs: 100 });
    await finished(db, web.id, { diffMs: 5, rerun: true });
    const [, result] = await orgTimings(db, ada.id, org.id, now);
    expect(result?.builds).toBe(1);
    expect(result?.steps.diff).toEqual({ p50: 100, p95: 100, n: 1 });
  });

  test("only a member reads an org's timings, and only that org's projects", async () => {
    const { db, org, web } = await setup();
    await finished(db, web.id, { diffMs: 100 });
    const bob = await signInGithubUser(db, profile(2, "bob"));
    await expect(orgTimings(db, bob.id, org.id, now)).rejects.toThrow(NotFoundError);
    const bobsOrg = await createOrg(db, bob.id, "Bobs");
    await createProject(db, bob.id, bobsOrg.id, "app");
    const own = await orgTimings(db, bob.id, bobsOrg.id, now);
    expect(own.map((p) => p.name)).toEqual(["app"]);
    expect(own[0]?.builds).toBe(0);
  });

  test("a smoke org has no timings", async () => {
    const { db, ada, org, web } = await setup();
    await finished(db, web.id, { diffMs: 100 });
    await db.update(orgs).set({ isSmoke: true }).where(eq(orgs.id, org.id));
    expect(await orgTimings(db, ada.id, org.id, now)).toEqual([]);
  });
});
