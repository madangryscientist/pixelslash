import { describe, expect, test } from "vitest";
import { nowSection } from "./admin-health-now";
import { sweepAbandoned } from "./abandoned";
import { createOrg, createProject } from "./orgs";
import { builds } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

const NOW = new Date("2026-11-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

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
  return { db, projectId: project.id };
}

describe("an ended abandoned build on the operator page", () => {
  test("is no longer in flight, and a live one still is", async () => {
    const { db, projectId } = await setup();
    const row = { projectId, commitSha: "abc", branch: "feat/x" };
    await db.insert(builds).values([
      { ...row, id: "gone-up", status: "uploading", createdAt: ago(30 * HOUR) },
      {
        ...row,
        id: "gone-proc",
        status: "processing",
        createdAt: ago(30 * HOUR),
        processingStartedAt: ago(29 * HOUR),
      },
      { ...row, id: "live", status: "uploading", createdAt: ago(HOUR) },
    ]);
    const before = await nowSection(db, NOW);
    expect(before.inFlight).toBe(3);

    expect((await sweepAbandoned(db, { now: NOW, limit: 100 })).toSorted()).toEqual([
      "gone-proc",
      "gone-up",
    ]);

    const after = await nowSection(db, NOW);
    expect(after.byStatus).toEqual({ uploading: 1, errored: 2 });
    expect(after.inFlight).toBe(1);
    expect(after.oldestInFlight?.id).toBe("live");
    expect(after.flying.map((b) => b.id)).toEqual(["live"]);
    expect(after.stuckTotal).toBe(0);
  });
});
