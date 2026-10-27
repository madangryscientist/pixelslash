import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { awaitsDecision, skippedFlaky } from "#/lib/snapshot-groups";
import { NotFoundError } from "./db";
import { type SentFlake, listFlakes, markFlaky, resolveFlake, setFlakeStatus } from "./flakes";
import { acceptAllSnapshots, countBuilds } from "./review";
import { type FlakyPolicy, flakes } from "./schema";
import { signInGithubUser } from "./users";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/** The record and re-captures the CLI sends for a shot whose run 2 differed (ob 1737). */
const flakeOf = (policy: FlakyPolicy): SentFlake => ({
  record: { runs: 3, differed: [2], regions: [], engineVersion: "0.1.0", policy },
  captures: [
    { run: 2, png: shot({ blocks: [block] }).buffer },
    { run: 3, png: shot().buffer },
  ],
});

/** Main's baseline for `about`, then a feature build where `about` changed. */
async function mainThen(
  ctx: Ctx,
  n: number,
  about: { flaky?: FlakyPolicy | null; flake?: SentFlake | null },
) {
  if (n === 2)
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "about", png: shot() }] });
  return upload(ctx, {
    branch: "feature",
    commit: sha(n),
    mergeBase: sha(1),
    shots: [{ name: "about", png: shot({ blocks: [block] }), ...about }],
  });
}

describe("flakes are stored per key (ob 1724)", () => {
  test("two detections from two builds are one flake with two evidence entries", async () => {
    const ctx = await context();
    const first = await mainThen(ctx, 2, { flaky: "review", flake: flakeOf("review") });
    const second = await mainThen(ctx, 3, { flaky: "review", flake: flakeOf("review") });
    const all = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    expect(all).toHaveLength(1);
    const [flake] = all;
    expect(flake?.status).toBe("open");
    expect(flake?.evidence.map((e) => e.buildId)).toEqual([first.id, second.id]);
    expect(flake?.evidence[0]?.captures.map((c) => c.run)).toEqual([2, 3]);
    // The re-captures are stored beside the shot.
    const key = flake?.evidence[0]?.captures[0]?.key ?? "";
    expect(key).toMatch(/\.flake-run2\.png$/);
    expect(ctx.blobs.data.has(`orgs/${ctx.orgId}/${key}`)).toBe(true);
    expect((await onlyShot(ctx, second)).flakeId).toBe(flake?.id);
  });

  test("a detection on a resolved flake reopens it", async () => {
    const ctx = await context();
    await mainThen(ctx, 2, { flake: flakeOf("review") });
    const [flake] = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    if (!flake) throw new Error("no flake");
    await resolveFlake(ctx.db, {
      projectId: ctx.projectId,
      flakeId: flake.id,
      userId: ctx.userId,
      note: "fixed the font load",
    });
    const [resolved] = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolvedBy: "ada",
      resolutionNote: "fixed the font load",
    });
    await mainThen(ctx, 3, { flake: flakeOf("review") });
    const [reopened] = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    expect(reopened).toMatchObject({
      id: flake.id,
      status: "open",
      resolvedBy: null,
      resolutionNote: null,
    });
    expect(reopened?.evidence).toHaveLength(2);
  });

  test("a shot uploaded while its key's flake is open is labelled; after resolve it is not", async () => {
    const ctx = await context();
    await mainThen(ctx, 2, { flake: flakeOf("review") });
    const labelled = await mainThen(ctx, 3, {});
    const [flake] = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    expect((await onlyShot(ctx, labelled)).flakeId).toBe(flake?.id);
    await setFlakeStatus(ctx.db, {
      userId: ctx.userId,
      projectId: ctx.projectId,
      flakeId: flake?.id ?? "",
      open: false,
      note: null,
    });
    const plain = await mainThen(ctx, 4, {});
    expect((await onlyShot(ctx, plain)).flakeId).toBeNull();
    // The earlier label stays, as history.
    expect((await onlyShot(ctx, labelled)).flakeId).toBe(flake?.id);
  });

  test("a hand mark opens a flake with no evidence, and its note", async () => {
    const ctx = await context();
    const build = await mainThen(ctx, 2, {});
    const about = await onlyShot(ctx, build);
    const { flakeId: id, buildId } = await markFlaky(ctx.db, {
      userId: ctx.userId,
      projectId: ctx.projectId,
      snapshotId: about.id,
      note: "animation",
    });
    expect(buildId).toBe(build.id);
    const [flake] = await listFlakes(ctx.db, ctx.userId, ctx.projectId);
    expect(flake).toMatchObject({ id, status: "open", evidence: [], note: "animation" });
    expect(flake?.createdBy).toBe("ada");
    expect((await onlyShot(ctx, build)).flakeId).toBe(id);
  });

  test("a user outside the project's org reaches no flake", async () => {
    const ctx = await context();
    await mainThen(ctx, 2, { flake: flakeOf("review") });
    const [flake] = await ctx.db.select().from(flakes);
    const eve = await signInGithubUser(ctx.db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await expect(listFlakes(ctx.db, eve.id, ctx.projectId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setFlakeStatus(ctx.db, {
        userId: eve.id,
        projectId: ctx.projectId,
        flakeId: flake?.id ?? "",
        open: false,
        note: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("the flaky policy decides the verdict (ob 1724)", () => {
  test("review: the flaky shot waits and blocks", async () => {
    const ctx = await context();
    const build = await mainThen(ctx, 2, { flaky: "review", flake: flakeOf("review") });
    expect(build.status).toBe("changes");
    const about = await onlyShot(ctx, build);
    expect(awaitsDecision(about)).toBe(true);
    expect(skippedFlaky(about)).toBe(false);
  });

  test("no policy sent behaves as review", async () => {
    const ctx = await context();
    const build = await mainThen(ctx, 2, { flaky: null, flake: flakeOf("review") });
    const about = await onlyShot(ctx, build);
    expect(about.flakeId).not.toBeNull();
    expect(about.flakyPolicy).toBe("review");
    expect(build.status).toBe("changes");
    // A shot labelled by an open flake but sent no policy at all is review too.
    const next = await mainThen(ctx, 3, {});
    expect((await onlyShot(ctx, next)).flakyPolicy).toBeNull();
    expect(next.status).toBe("changes");
  });

  test("skip: the shot does not wait or block, is not accepted, and counts on its own", async () => {
    const ctx = await context();
    const build = await mainThen(ctx, 2, { flaky: "skip", flake: flakeOf("skip") });
    expect(build.status).toBe("passed");
    const about = await onlyShot(ctx, build);
    expect(about.reviewState).toBe("pending");
    expect(skippedFlaky(about)).toBe(true);
    expect(awaitsDecision(about)).toBe(false);
    const counts = (await countBuilds(ctx.db, [build.id])).get(build.id);
    expect(counts).toMatchObject({ toReview: 0, skippedFlaky: 1, changed: 1 });
    // Accept all passes it by: its baseline does not move.
    await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: build.id,
      userId: ctx.userId,
    });
    expect((await onlyShot(ctx, build)).reviewState).toBe("pending");
  });

  test("skip: the next build is measured against the old baseline, not the skipped shot", async () => {
    const ctx = await context();
    await mainThen(ctx, 2, { flaky: "skip", flake: flakeOf("skip") });
    // Identical to the skipped shot: were it a baseline, this would be unchanged.
    const next = await mainThen(ctx, 3, { flaky: "skip" });
    const about = await onlyShot(ctx, next);
    expect(about.diffStatus).toBe("changed");
    expect(about.carriedFrom).toBeNull();
    expect(next.status).toBe("passed");
  });

  test("the default branch never auto-accepts a flaky shot, under either policy", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [
        { name: "about", png: shot() },
        { name: "home", png: shot() },
      ],
    });
    for (const [n, policy] of [
      [2, "skip"],
      [3, "review"],
    ] as const) {
      const build = await upload(ctx, {
        branch: "main",
        commit: sha(n),
        ancestors: [sha(1)],
        shots: [
          { name: "about", png: shot({ blocks: [block] }), flaky: policy, flake: flakeOf(policy) },
          { name: "home", png: shot() },
        ],
      });
      const byName = new Map((await rows(ctx, build)).map((r) => [r.name, r]));
      expect(byName.get("home")?.reviewState).toBe("accepted");
      expect(byName.get("about")?.reviewState).toBe("pending");
      expect(build.status).toBe(policy === "skip" ? "passed" : "changes");
    }
    // The flaky change never became main's baseline.
    const [flake] = await ctx.db.select().from(flakes).where(eq(flakes.name, "about"));
    expect(flake?.evidence).toHaveLength(2);
  });
});
