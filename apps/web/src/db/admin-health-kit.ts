import { createOrg, createProject } from "./orgs";
import { builds, snapshots } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

/** The org, project and build rows the operator health tests start from. */

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
  return { db, org, project };
}

type Row = Partial<typeof builds.$inferInsert> & { projectId: string };

export async function build(db: ReturnType<typeof testDb>, row: Row) {
  const id = crypto.randomUUID();
  await db
    .insert(builds)
    .values({ id, commitSha: "abc", branch: "main", status: "passed", ...row });
  return id;
}

export async function shot(
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
