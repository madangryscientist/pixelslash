import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { DAY_MS } from "#/lib/retention";
import { orgSweepBlobs } from "#/storage/blobs";
import type { Build } from "./builds";
import { flakes, builds, snapshots } from "./schema";
import { listFlakes } from "./flakes";
import { referencedBuilds, sweepRetention } from "./retention";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };
const NOW = new Date("2026-10-28T12:00:00Z");
const WINDOW = 30;

/** Move a build back in time, so it is `days` old at NOW. */
async function age(ctx: Ctx, build: Build, days: number): Promise<void> {
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(NOW.getTime() - days * DAY_MS) })
    .where(eq(builds.id, build.id));
}

const sweep = (ctx: Ctx, extra: { dryRun?: boolean; limit?: number } = {}) =>
  sweepRetention(ctx.db, (orgId) => orgSweepBlobs(ctx.blobs.store, orgId), {
    days: WINDOW,
    now: NOW,
    dryRun: extra.dryRun ?? false,
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
  });

const buildIds = async (ctx: Ctx) =>
  (await ctx.db.select({ id: builds.id }).from(builds)).map((b) => b.id);
const blobsOf = (ctx: Ctx, build: Build) =>
  [...ctx.blobs.data.keys()].filter((k) => k.includes(`/builds/${build.id}/`));

/** A branch build with one shot, on its own commit and with no ancestry, so nothing else is its baseline. */
const alone = (ctx: Ctx, branch: string, n: number, blocks = false) =>
  upload(ctx, {
    branch,
    commit: sha(n),
    shots: [{ png: shot(blocks ? { blocks: [block] } : {}) }],
  });

describe("what the sweep deletes", () => {
  test("a build past the window on a branch goes, with its blobs and rows", async () => {
    const ctx = await context();
    const old = await alone(ctx, "feature", 2);
    await age(ctx, old, 40);
    const { plan, result } = await sweep(ctx);
    expect(plan.expired.map((b) => b.id)).toEqual([old.id]);
    expect(result?.buildsDeleted).toBe(1);
    expect(await buildIds(ctx)).toEqual([]);
    expect(await ctx.db.select().from(snapshots)).toEqual([]);
    expect(blobsOf(ctx, old)).toEqual([]);
    expect(ctx.blobs.data.size).toBe(0);
  });

  test("a build inside the window stays", async () => {
    const ctx = await context();
    const fresh = await alone(ctx, "feature", 2);
    await age(ctx, fresh, WINDOW - 1);
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(await buildIds(ctx)).toEqual([fresh.id]);
  });

  test("a default-branch build is never deleted, however old", async () => {
    const ctx = await context();
    const main = await alone(ctx, "main", 1);
    await age(ctx, main, 400);
    const { plan, result } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(result?.buildsDeleted).toBe(0);
    expect(await buildIds(ctx)).toEqual([main.id]);
    expect(blobsOf(ctx, main).length).toBeGreaterThan(0);
  });

  test("only the build's own blobs go, and only that org's", async () => {
    const ctx = await context();
    const old = await alone(ctx, "feature", 2);
    const other = await alone(ctx, "other", 3);
    await age(ctx, old, 40);
    await age(ctx, other, 1);
    const before = blobsOf(ctx, other);
    await sweep(ctx);
    expect(blobsOf(ctx, other)).toEqual(before);
    expect(await buildIds(ctx)).toEqual([other.id]);
  });
});

describe("a dry run deletes nothing", () => {
  test("it lists the builds and the bytes, and leaves rows and blobs alone", async () => {
    const ctx = await context();
    const old = await alone(ctx, "feature", 2);
    await age(ctx, old, 40);
    const blobs = new Map(ctx.blobs.data);
    const { plan, result } = await sweep(ctx, { dryRun: true });
    expect(result).toBeNull();
    expect(plan.expired.map((b) => b.id)).toEqual([old.id]);
    const listed = plan.expired.flatMap((b) => b.blobs);
    expect(listed.map((b) => b.key).toSorted()).toEqual(
      [...blobs.keys()].map((k) => k.replace(`orgs/${ctx.orgId}/`, "")).toSorted(),
    );
    expect(listed.reduce((sum, b) => sum + b.size, 0)).toBe(
      [...blobs.values()].reduce((sum, b) => sum + b.byteLength, 0),
    );
    expect(await buildIds(ctx)).toEqual([old.id]);
    expect(ctx.blobs.data).toEqual(blobs);
  });
});

describe("a baseline a live build still points at is never deleted", () => {
  test("the previous shot of a branch that is still being built on", async () => {
    const ctx = await context();
    const first = await alone(ctx, "feature", 2);
    const second = await alone(ctx, "feature", 3);
    expect((await onlyShot(ctx, second)).baselineKey).toBe((await onlyShot(ctx, first)).imageKey);
    await age(ctx, first, 40);
    await age(ctx, second, 2);
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(plan.keptReferenced).toEqual([first.id]);
    expect(await buildIds(ctx)).toHaveLength(2);
    expect(blobsOf(ctx, first).length).toBeGreaterThan(0);
  });

  test("a chain is followed: what a kept build points at is kept too", async () => {
    const ctx = await context();
    // Each is aged before the next uploads, so the next one's baseline is the newest, not a tie.
    const first = await alone(ctx, "feature", 2);
    await age(ctx, first, 50);
    const second = await alone(ctx, "feature", 3);
    await age(ctx, second, 40);
    const third = await alone(ctx, "feature", 4);
    await age(ctx, third, 1);
    expect((await onlyShot(ctx, third)).baselineKey).toBe((await onlyShot(ctx, second)).imageKey);
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(plan.keptReferenced.toSorted()).toEqual([first.id, second.id].toSorted());
  });

  test("when the last build that points at them ages out, the whole chain goes", async () => {
    const ctx = await context();
    const first = await alone(ctx, "feature", 2);
    const second = await alone(ctx, "feature", 3);
    await age(ctx, first, 50);
    await age(ctx, second, 40);
    const { plan, result } = await sweep(ctx);
    expect(plan.expired.map((b) => b.id).toSorted()).toEqual([first.id, second.id].toSorted());
    expect(result?.buildsDeleted).toBe(2);
    expect(ctx.blobs.data.size).toBe(0);
  });

  test("a removed marker keeps the build whose blob it shows", async () => {
    const ctx = await context();
    const first = await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      shots: [
        { name: "home", png: shot() },
        { name: "gone", png: shot({ blocks: [block] }) },
      ],
    });
    const second = await upload(ctx, {
      branch: "feature",
      commit: sha(3),
      shots: [{ name: "home", png: shot() }],
    });
    const marker = (await rows(ctx, second)).find((r) => r.diffStatus === "removed");
    expect(marker?.baselineKey).toBeTruthy();
    await age(ctx, first, 40);
    await age(ctx, second, 1);
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(blobsOf(ctx, first)).toContain(`orgs/${ctx.orgId}/${marker?.baselineKey}`);
  });

  test("the default branch's own baseline is a default-branch build, so it stays", async () => {
    const ctx = await context();
    const main = await alone(ctx, "main", 1);
    const feature = await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: shot({ blocks: [block] }) }],
    });
    await age(ctx, main, 90);
    await age(ctx, feature, 1);
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(await buildIds(ctx)).toHaveLength(2);
  });

  // The columns that name another build's shot, set by hand on a build that stays.
  test.each([
    ["baseline_key", (s: { imageKey: string; id: string }) => ({ baselineKey: s.imageKey })],
    [
      "main_baseline_key",
      (s: { imageKey: string; id: string }) => ({ mainBaselineKey: s.imageKey }),
    ],
    [
      "baseline_snapshot_id",
      (s: { imageKey: string; id: string }) => ({ baselineSnapshotId: s.id }),
    ],
    ["carried_from", (s: { imageKey: string; id: string }) => ({ carriedFrom: s.id })],
  ])("%s", async (_column, point) => {
    const ctx = await context();
    const old = await alone(ctx, "old", 2);
    const live = await alone(ctx, "live", 3);
    await age(ctx, old, 40);
    await age(ctx, live, 1);
    const oldShot = await onlyShot(ctx, old);
    const { plan: before } = await sweep(ctx, { dryRun: true });
    expect(before.expired.map((b) => b.id)).toEqual([old.id]);
    await ctx.db
      .update(snapshots)
      .set(point(oldShot))
      .where(eq(snapshots.id, (await onlyShot(ctx, live)).id));
    const { plan } = await sweep(ctx);
    expect(plan.expired).toEqual([]);
    expect(plan.keptReferenced).toEqual([old.id]);
    expect(await buildIds(ctx)).toHaveLength(2);
    expect(blobsOf(ctx, old).length).toBeGreaterThan(0);
  });
});

const edges = (pairs: [string, string[]][]) => new Map(pairs.map(([k, v]) => [k, new Set(v)]));

describe("referencedBuilds", () => {
  test("a build outside the candidates is a root; its targets and theirs are kept", () => {
    const kept = referencedBuilds(
      new Set(["a", "b", "c"]),
      edges([
        ["live", ["a"]],
        ["a", ["b"]],
      ]),
    );
    expect([...kept].toSorted()).toEqual(["a", "b"]);
  });

  test("a cycle among candidates with no root keeps nothing", () => {
    const kept = referencedBuilds(
      new Set(["a", "b"]),
      edges([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    );
    expect(kept.size).toBe(0);
  });
});

describe("running a sweep", () => {
  test("the limit takes the oldest first and the rest wait", async () => {
    const ctx = await context();
    const builds3 = [await alone(ctx, "a", 2), await alone(ctx, "b", 3), await alone(ctx, "c", 4)];
    await age(ctx, builds3[0]!, 60);
    await age(ctx, builds3[1]!, 50);
    await age(ctx, builds3[2]!, 40);
    const { plan } = await sweep(ctx, { limit: 2 });
    expect(plan.expired.map((b) => b.id)).toEqual([builds3[0]!.id, builds3[1]!.id]);
    expect(await buildIds(ctx)).toEqual([builds3[2]!.id]);
    const again = await sweep(ctx, { limit: 2 });
    expect(again.plan.expired.map((b) => b.id)).toEqual([builds3[2]!.id]);
    expect((await sweep(ctx)).plan.expired).toEqual([]);
  });

  test("the limit does not stop a chain of expired builds from clearing", async () => {
    const ctx = await context();
    const chain: Build[] = [];
    // Aged as they go, so each one's baseline is the one before it.
    for (const seed of [2, 3, 4]) {
      const next = await alone(ctx, "feature", seed);
      await age(ctx, next, 80 - seed * 10);
      chain.push(next);
    }
    const { plan } = await sweep(ctx, { limit: 2 });
    expect(plan.expired.map((b) => b.id)).toEqual([chain[0]!.id, chain[1]!.id]);
    expect(await buildIds(ctx)).toEqual([chain[2]!.id]);
  });

  test("a sweep that died after the blobs and before the rows is finished by the next one", async () => {
    const ctx = await context();
    const old = await alone(ctx, "feature", 2);
    await age(ctx, old, 40);
    for (const key of blobsOf(ctx, old)) ctx.blobs.data.delete(key);
    const { plan, result } = await sweep(ctx);
    expect(plan.expired.map((b) => b.id)).toEqual([old.id]);
    expect(result).toMatchObject({ buildsDeleted: 1, blobsDeleted: 0, bytesFreed: 0 });
    expect(await buildIds(ctx)).toEqual([]);
  });

  test("a deleted build's flake evidence goes with it; the flake stays", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: shot() }] });
    const flaky = await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [
        {
          png: shot({ blocks: [block] }),
          flaky: "review",
          flake: {
            record: {
              runs: 2,
              differed: [2],
              regions: [],
              engineVersion: "0.1.0",
              policy: "review",
            },
            captures: [{ run: 2, png: shot().buffer }],
          },
        },
      ],
    });
    expect(blobsOf(ctx, flaky).some((k) => k.includes(".flake-run2"))).toBe(true);
    await age(ctx, flaky, 40);
    await sweep(ctx);
    expect(blobsOf(ctx, flaky)).toEqual([]);
    const [flake] = await ctx.db.select().from(flakes);
    expect(flake?.evidence).toEqual([]);
    expect(await listFlakes(ctx.db, ctx.userId, ctx.projectId)).toHaveLength(1);
  });
});
