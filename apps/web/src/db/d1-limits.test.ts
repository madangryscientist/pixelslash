import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryStore } from "#/api/test-support";
import { rediffShots } from "#/diff/rerun";
import { type Uploads, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { orgBlobs } from "#/storage/blobs";
import { snapshotDiffOptions } from "./builds";
import { listBuilds } from "./build-list";
import type { Db } from "./db";
import { snapshotIgnoreBoxes, snapshotOverrides } from "./override-export";
import { overrideChanges } from "./overrides";
import { createOrg, createProject, listOrgs } from "./orgs";
import { acceptAllSnapshots, buildView } from "./review";
import { d1Db } from "./test-d1";
import { signInGithubUser } from "./users";

/**
 * A build bigger than D1's 100 bound parameters per statement (ob 1773). In-memory SQLite allows
 * far more, so this runs on a local D1 (miniflare), which refuses such a statement as D1 does.
 */

const SHOTS = 250;
const names = Array.from({ length: SHOTS }, (_, i) => `s${String(i).padStart(3, "0")}`);
const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const every = (png: typeof white) => names.map((name) => ({ name, png }));

/**
 * The diff stops itself at a wall-clock budget (`DIFF_BUDGET_MS`). This test measures D1's
 * parameter limit, not diff speed, so its clock never moves and a slow runner cannot run the budget
 * out: a build that ends `errored`, or a main build that does not finish, would fail it on timing.
 */
const frozen = { now: () => 0 };

let held: { db: Db; dispose: () => Promise<void> };
let ctx: Uploads & { userId: string };

beforeAll(async () => {
  held = await d1Db();
  const { db } = held;
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, user.id, "Acme");
  const project = await createProject(db, user.id, org.id, { name: "web", diffLocation: "server" });
  const { store } = memoryStore();
  ctx = { db, projectId: project.id, userId: user.id, scoped: orgBlobs(store, org.id) };
}, 60_000);

afterAll(() => held?.dispose());

describe(`a build of ${SHOTS} shots on a local D1 (ob 1773)`, () => {
  test("the build page, its snapshot pages and a re-diff load without error", async () => {
    await upload(ctx, { branch: "main", commit: sha(1), shots: every(white) }, frozen);
    const first = await upload(
      ctx,
      { branch: "feat", commit: sha(2), mergeBase: sha(1), shots: every(red) },
      frozen,
    );
    expect(first.status).toBe("changes");
    await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: first.id,
      userId: ctx.userId,
    });
    const second = await upload(
      ctx,
      { branch: "feat", commit: sha(3), mergeBase: sha(1), shots: every(red) },
      frozen,
    );
    expect(second.status).toBe("passed");

    // The build page.
    const view = await buildView(ctx.db, ctx.projectId, second.id);
    expect(view.snapshots).toHaveLength(SHOTS);
    expect(view.snapshots.every((s) => s.approvedEarlier?.buildId === first.id)).toBe(true);
    const shotNames = [...new Set(view.snapshots.map((s) => s.name))];
    expect(await overrideChanges(ctx.db, ctx.userId, ctx.projectId, shotNames)).toEqual([]);

    // The snapshot pages: the first, a middle and the last shot.
    for (const snapshot of [view.snapshots[0], view.snapshots[SHOTS >> 1], view.snapshots.at(-1)]) {
      if (!snapshot) throw new Error("no shot");
      await snapshotDiffOptions(ctx.db, snapshot.id);
      await snapshotOverrides(ctx.db, ctx.userId, ctx.projectId, snapshot);
      await snapshotIgnoreBoxes(ctx.db, ctx.userId, ctx.projectId, snapshot);
    }

    // The project and organizations pages count every build's shots.
    expect(await listBuilds(ctx.db, ctx.projectId)).toHaveLength(3);
    expect(await listOrgs(ctx.db, ctx.userId)).toHaveLength(1);

    // A re-diff of every shot, as a review-UI override that applies to all of them does.
    const ids = (await rows(ctx, second)).map((row) => row.id);
    const result = await rediffShots({ db: ctx.db, blobs: ctx.scoped, ...frozen }, second, ids);
    expect(result).toMatchObject({ status: "passed", error: null });
    const after = await buildView(ctx.db, ctx.projectId, second.id);
    expect(after.snapshots.every((s) => s.diffStatus === "unchanged")).toBe(true);
  }, 300_000);

  test("the merge-base and 200 ancestors reach the baseline query in parts (ob 1788)", async () => {
    const old = await upload(ctx, { branch: "main", commit: sha(1001), shots: [{ png: white }] });
    const history = Array.from({ length: 200 }, (_, i) => sha(1150 - i));
    const branch = await upload(ctx, {
      branch: "deep",
      commit: sha(5000),
      mergeBase: sha(1151),
      ancestors: history,
      shots: [{ png: red }],
    });
    expect((await rows(ctx, branch))[0]).toMatchObject({
      diffStatus: "changed",
      baselineKey: (await rows(ctx, old))[0]?.imageKey,
    });
  }, 60_000);
});
