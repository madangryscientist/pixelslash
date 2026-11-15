import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { issueOrgToken, issueUserToken } from "#/db/tokens";
import { createOrg } from "#/db/orgs";
import { signInGithubUser } from "#/db/users";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { syncCheckRuns } from "#/github/check-run";
import { call, idOf } from "./test-support";

vi.mock("#/github/check-run", async (original) => {
  const real = await original<typeof import("#/github/check-run")>();
  return { ...real, syncCheckRuns: vi.fn<typeof real.syncCheckRuns>(real.syncCheckRuns) };
});

afterEach(() => vi.clearAllMocks());

/** Review over API v1: a person's token decides, with the web app's effect. */

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/** A main build and a feature build that changes `about`, with a personal token for its org's member. */
async function changed() {
  const ctx = await context();
  // With no App and no token, the sync calls nothing outside; the spy still sees what it was given.
  ctx.deps.checkRuns = { app: null, token: null, publicUrl: undefined };
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot() },
    ],
  });
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(builds.commitSha, sha(1)));
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
    ],
  });
  expect(feature.status).toBe("changes");
  const [about] = await ctx.db
    .select()
    .from(snapshots)
    .where(eq(snapshots.buildId, feature.id))
    .then((rows) => rows.filter((s) => s.name === "about"));
  if (!about) throw new Error("no about shot");
  const ada = (await issueUserToken(ctx.db, ctx.userId, "laptop", null)).token;
  vi.mocked(syncCheckRuns).mockClear();
  return { ctx, feature, about, ada };
}

type Body = {
  status: string;
  build_ids: string[];
  error: { code: string; message: string };
};
async function json(res: Response) {
  const body: Body = await res.json();
  return { status: res.status, body };
}

const review = (
  ctx: Awaited<ReturnType<typeof changed>>["ctx"],
  id: string,
  token: string,
  b: unknown,
) => call(ctx.deps, `POST /api/v1/snapshots/${id}/review`, token, JSON.stringify(b)).then(json);
const acceptAll = (ctx: Awaited<ReturnType<typeof changed>>["ctx"], id: string, token: string) =>
  call(ctx.deps, `POST /api/v1/builds/${id}/accept-all`, token).then(json);

const buildStatus = async (ctx: Awaited<ReturnType<typeof changed>>["ctx"], id: string) =>
  (await ctx.db.select().from(builds).where(eq(builds.id, id)))[0]?.status;

const syncedIds = () => vi.mocked(syncCheckRuns).mock.calls.map(([, ids]) => [...ids]);

describe("review over the API", () => {
  test("accepting the changed shot passes the build, under the token's user, and syncs it", async () => {
    const { ctx, feature, about, ada } = await changed();
    const res = await review(ctx, about.id, ada, { state: "accepted" });
    expect(res).toMatchObject({ status: 200, body: { status: "passed" } });
    expect(res.body.build_ids[0]).toBe(feature.id);
    expect(await buildStatus(ctx, feature.id)).toBe("passed");
    const [row] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, about.id));
    expect(row).toMatchObject({ reviewState: "accepted", reviewedBy: ctx.userId });
    expect(syncedIds()).toEqual([res.body.build_ids]);

    // The read API names the reviewer as the web app does.
    const read = await call(ctx.deps, `GET /api/v1/snapshots/${about.id}`, ada);
    const shotBody: { snapshot: { reviewed_by: string; review_state: string } } = await read.json();
    expect(shotBody.snapshot).toMatchObject({ reviewed_by: "ada", review_state: "accepted" });
  });

  test("rejecting the changed shot fails the build", async () => {
    const { ctx, feature, about, ada } = await changed();
    const res = await review(ctx, about.id, ada, { state: "rejected" });
    expect(res).toMatchObject({ status: 200, body: { status: "failed" } });
    expect(await buildStatus(ctx, feature.id)).toBe("failed");
    expect(syncedIds()).toEqual([res.body.build_ids]);
  });

  test("accept-all passes the build and syncs it; a rejected build's accept-all is 409", async () => {
    const { ctx, feature, about, ada } = await changed();
    const res = await acceptAll(ctx, feature.id, ada);
    expect(res).toMatchObject({ status: 200, body: { status: "passed" } });
    expect(res.body.build_ids[0]).toBe(feature.id);
    expect(await buildStatus(ctx, feature.id)).toBe("passed");
    const [row] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, about.id));
    expect(row).toMatchObject({ reviewState: "accepted", reviewedBy: ctx.userId });
    expect(syncedIds()).toEqual([res.body.build_ids]);

    await review(ctx, about.id, ada, { state: "rejected" });
    vi.mocked(syncCheckRuns).mockClear();
    const refused = await acceptAll(ctx, feature.id, ada);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    expect(await buildStatus(ctx, feature.id)).toBe("failed");
    expect(syncedIds()).toEqual([]);
  });

  test("a bad state is 400 and writes nothing", async () => {
    const { ctx, feature, about, ada } = await changed();
    for (const body of [{ state: "approved" }, {}, "accepted"])
      expect(await review(ctx, about.id, ada, body)).toMatchObject({
        status: 400,
        body: { error: { code: "bad_request" } },
      });
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(syncedIds()).toEqual([]);
  });

  test("a CI or org token is 403 on any id or body", async () => {
    const { ctx, feature, about } = await changed();
    const org = (await issueOrgToken(ctx.db, ctx.userId, ctx.orgId, "ci")).token;
    for (const token of [ctx.acme.token, org]) {
      for (const id of [about.id, "missing"])
        for (const body of [{ state: "accepted" }, { state: "nope" }])
          expect((await review(ctx, id, token, body)).status).toBe(403);
      for (const id of [feature.id, "missing"])
        expect(await acceptAll(ctx, id, token)).toMatchObject({
          status: 403,
          body: { error: { code: "forbidden" } },
        });
    }
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(syncedIds()).toEqual([]);
  });

  test("an unknown id, or a project the user is not a member of, is 404", async () => {
    const { ctx, feature, about, ada } = await changed();
    expect((await review(ctx, "missing", ada, { state: "accepted" })).status).toBe(404);
    expect((await acceptAll(ctx, "missing", ada)).status).toBe(404);

    const eve = await signInGithubUser(ctx.db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await createOrg(ctx.db, eve.id, "Elsewhere");
    const theirs = (await issueUserToken(ctx.db, eve.id, "laptop", null)).token;
    expect(await review(ctx, about.id, theirs, { state: "accepted" })).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect((await acceptAll(ctx, feature.id, theirs)).status).toBe(404);
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(syncedIds()).toEqual([]);
  });

  test("a build still uploading is 409", async () => {
    const { ctx, ada } = await changed();
    const open = await call(
      ctx.deps,
      "POST /api/v1/builds",
      ctx.acme.token,
      JSON.stringify({ commitSha: sha(9), branch: "feature" }),
    );
    expect((await acceptAll(ctx, await idOf(open), ada)).status).toBe(409);
  });
});
