import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createOrg, createProject } from "./orgs";
import { builds, orgs, snapshots } from "./schema";
import { type Db } from "./db";
import { testDb } from "./test-db";
import { usageCounts } from "./usage";
import { signInGithubUser } from "./users";

async function buildWithSnapshots(db: Db, projectId: string, n: number) {
  const buildId = crypto.randomUUID();
  await db.insert(builds).values({ id: buildId, projectId, commitSha: "abc", branch: "main" });
  for (let i = 0; i < n; i++)
    await db.insert(snapshots).values({
      id: crypto.randomUUID(),
      buildId,
      name: `page-${i}`,
      platform: "web",
      browser: "chromium",
      viewport: "1280x720",
      theme: "light",
      envFingerprint: "fp",
      imageKey: `builds/${buildId}/${i}.png`,
    });
}

describe("usage counts", () => {
  test("a smoke org's builds and snapshots are not counted", async () => {
    const db = testDb();
    const real = await signInGithubUser(db, {
      githubId: 1,
      login: "ada",
      name: null,
      avatarUrl: null,
    });
    const realProject = await createProject(
      db,
      real.id,
      (await createOrg(db, real.id, "Real")).id,
      "web",
    );
    await buildWithSnapshots(db, realProject.id, 3);
    const before = await usageCounts(db);

    const smoke = await signInGithubUser(db, {
      githubId: 9,
      login: "smoke-bot",
      name: null,
      avatarUrl: null,
    });
    const smokeOrg = await createOrg(db, smoke.id, "Smoke");
    await db.update(orgs).set({ isSmoke: true }).where(eq(orgs.id, smokeOrg.id));
    await buildWithSnapshots(db, (await createProject(db, smoke.id, smokeOrg.id, "web")).id, 5);

    expect(before).toEqual({ builds: 1, snapshots: 3 });
    expect(await usageCounts(db)).toEqual(before);
  });
});
