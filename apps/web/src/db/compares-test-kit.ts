import { createOrg, createProject } from "./orgs";
import { builds, snapshots } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

/** Builds and shot rows for the compare-time tests (PS-336). */

export type TestDb = ReturnType<typeof testDb>;
export type ShotRow = Partial<typeof snapshots.$inferInsert>;

export async function setup() {
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

export async function build(
  db: TestDb,
  projectId: string,
  over: Partial<typeof builds.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  await db
    .insert(builds)
    .values({ id, projectId, commitSha: "abc", branch: "x", status: "passed", ...over });
  return id;
}

const row = (buildId: string, over: ShotRow = {}) => ({
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

export async function shots(db: TestDb, buildId: string, list: ShotRow[]) {
  // A row is about 15 binds; D1's limit is not at stake in a test, SQLite's is.
  for (let i = 0; i < list.length; i += 500)
    await db.insert(snapshots).values(list.slice(i, i + 500).map((s) => row(buildId, s)));
}

/** A baseline row for `sha`, in a build of its own; returns its id for a same-bytes shot. */
export async function baseline(db: TestDb, projectId: string, sha: string) {
  const owner = await build(db, projectId);
  const base = row(owner, { imageSha256: sha });
  await db.insert(snapshots).values(base);
  return base.id;
}
