import { eq } from "drizzle-orm";
import { builds as buildRows, snapshots } from "#/db/schema";
import { issueUserToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { type ApiDeps, handleApi } from "./handler";
import type { ApiBuild, ApiFlag, ApiImages, ApiProject, ApiSnapshot } from "./read";

/** The read API's tests' world and client (ob 1729). Tests only. */

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/**
 * Acme holds a main build and a feature build that changes `about`, adds `pricing` and drops
 * `contact`; Other holds one build. Ada is in both orgs, Eve in neither.
 */
export async function world() {
  const ctx = await context();
  const main = await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot() },
      { name: "contact", png: shot() },
    ],
  });
  // `created_at` has second resolution: move main a minute back so the order is not a tie.
  await ctx.db
    .update(buildRows)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(buildRows.id, main.id));
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
      { name: "pricing", png: shot() },
    ],
  });
  const otherBuild = await upload(
    { ...ctx, projectId: ctx.other.project.id },
    { branch: "main", commit: sha(3), shots: [{ name: "home", png: shot() }] },
  );
  const ada = await issueUserToken(ctx.db, ctx.userId, "laptop", null);
  const eve = await signInGithubUser(ctx.db, {
    githubId: 2,
    login: "eve",
    name: "Eve",
    avatarUrl: null,
  });
  const eveToken = await issueUserToken(ctx.db, eve.id, "laptop", null);
  const shotOf = async (buildId: string, name: string) => {
    const rows = await ctx.db.select().from(snapshots).where(eq(snapshots.buildId, buildId));
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no ${name} in ${buildId}`);
    return row;
  };
  return { ...ctx, main, feature, otherBuild, ada: ada.token, eve: eveToken.token, shotOf };
}

/**
 * Every key a read reply can carry, typed as if all were there: a test reads the one its endpoint
 * sends and asserts the rest away. An upload endpoint's `error` is a string, compared whole.
 */
export type Reply = {
  api_version: number;
  error: { code: string; message: string };
  projects: ApiProject[];
  builds: ApiBuild[];
  build: ApiBuild & { snapshots: ApiSnapshot[] };
  snapshot: ApiSnapshot & { images: ApiImages };
  detection_flags: ApiFlag[];
  detection_flag: ApiFlag;
  next_cursor: string | null;
};

export async function get(
  deps: ApiDeps,
  path: string,
  token: string | null,
  { headers = {}, method = "GET" }: { headers?: Record<string, string>; method?: string } = {},
) {
  const res = await handleApi(
    new Request(`http://app.test${path}`, {
      method,
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }),
    deps,
  );
  const body: Reply = await res.json();
  return { status: res.status, body };
}
