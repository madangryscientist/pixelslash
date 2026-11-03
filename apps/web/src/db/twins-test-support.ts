import type { Db } from "./db";
import { createOrg, createProject } from "./orgs";
import { type BuildStatus, builds, snapshots } from "./schema";
import { testDb } from "./test-db";
import { signInGithubUser } from "./users";

/**
 * Fixture for the twin tests (PS-295): shots are inserted as the upload leaves them, so the
 * platform is the server's (`linux` for web) and the device is the `browser` column.
 */

export type Shot = {
  name?: string;
  platform?: "linux" | "android" | "ios";
  browser?: string;
  viewport?: string;
  theme?: string;
  state?: "pending" | "accepted";
  diff?: "new" | "unchanged" | "changed" | "removed" | null;
  metrics?: boolean;
};

export const PIXEL = "Pixel 8 API 35";
let n = 0;
const id = (prefix: string) => `${prefix}-${++n}`;
const sha = (k: number) => k.toString(16).padStart(40, "0");

/** What a shot of this platform is shot on and at, unless the test says otherwise. */
function surface(s: Shot) {
  const web = (s.platform ?? "linux") === "linux";
  return {
    browser: s.browser ?? (web ? "chromium" : PIXEL),
    viewport: s.viewport ?? (web ? "1280x720" : "412x915"),
  };
}

async function insertShot(db: Db, buildId: string, s: Shot) {
  const snapshotId = id("s");
  await db.insert(snapshots).values({
    id: snapshotId,
    buildId,
    name: s.name ?? "Button/primary",
    platform: s.platform ?? "linux",
    ...surface(s),
    theme: s.theme ?? "dark",
    envFingerprint: "{}",
    imageKey: `img/${snapshotId}`,
    metricsKey: s.metrics ? `metrics/${snapshotId}` : null,
    reviewState: s.state ?? "pending",
    diffStatus: s.diff === undefined ? "new" : s.diff,
  });
}

/** A fresh database with Ada, her org Acme and its projects `web` and `native`. */
export async function world() {
  const db = testDb();
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, user.id, "Acme");
  const web = (await createProject(db, user.id, org.id, "web")).id;
  const native = (await createProject(db, user.id, org.id, "native")).id;

  /** A build of `projectId` at commit number `commit` holding `shots`; a bigger `age` is older. */
  async function build(
    projectId: string,
    commit: number,
    shots: Shot[],
    extra: { status?: BuildStatus; age?: number } = {},
  ): Promise<string> {
    const buildId = id("b");
    await db.insert(builds).values({
      id: buildId,
      projectId,
      commitSha: sha(commit),
      branch: "main",
      status: extra.status ?? "passed",
      createdAt: new Date(Date.now() - (extra.age ?? 0) * 60_000),
    });
    for (const s of shots) await insertShot(db, buildId, s);
    return buildId;
  }

  async function idOf(buildId: string, name: string, platform: string, theme = "dark") {
    const rows = await db.select().from(snapshots);
    const row = rows.find(
      (r) =>
        r.buildId === buildId && r.name === name && r.platform === platform && r.theme === theme,
    );
    if (!row) throw new Error(`no ${name} ${platform} in ${buildId}`);
    return row.id;
  }

  return { db, userId: user.id, orgId: org.id, web, native, build, idOf };
}

export type World = Awaited<ReturnType<typeof world>>;
export const shaOf = sha;
