import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { context, sha } from "#/diff/test-builds";
import { shot } from "#/diff/test-shots";
import { BuildFinalisedError, createBuild, getBuild, putSnapshot } from "./builds";
import { builds, snapshots } from "./schema";

/** `putSnapshot` writes its row only while the build is `uploading`, in the same statement (PS-398). */

const input = (name: string) => ({
  name,
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
  tags: [],
  diff: {},
  ignore: [],
  fingerprint: { image: "version:1", browser: "chromium 148", fonts: "sha256:f" },
  flaky: null,
});

async function openBuild() {
  const ctx = await context();
  const id = await createBuild(ctx.db, ctx.projectId, {
    commitSha: sha(1),
    branch: "feature",
    mergeBaseSha: null,
    ancestorShas: [],
    prNumber: null,
    brief: null,
  });
  return { ctx, id, build: await getBuild(ctx.db, ctx.projectId, id) };
}

const send = (
  ctx: Awaited<ReturnType<typeof context>>,
  build: Parameters<typeof putSnapshot>[1],
  name: string,
) =>
  putSnapshot({ db: ctx.db, blobs: ctx.scoped }, build, {
    input: input(name),
    png: shot().buffer,
    flake: null,
  });

describe("putSnapshot", () => {
  test("a build finalised after the in-memory check writes no snapshot and throws BuildFinalisedError", async () => {
    const { ctx, id, build } = await openBuild();
    expect(build.status).toBe("uploading");
    // Another request finalises the build after this one read it: `build` is now stale.
    await ctx.db.update(builds).set({ status: "processing" }).where(eq(builds.id, id));
    await expect(send(ctx, build, "home")).rejects.toBeInstanceOf(BuildFinalisedError);
    expect(await ctx.db.select().from(snapshots).where(eq(snapshots.buildId, id))).toEqual([]);
  });

  test("a stale build also leaves an earlier row of the same shot untouched", async () => {
    const { ctx, id, build } = await openBuild();
    const first = await send(ctx, build, "home");
    const [before] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, first.id));
    await ctx.db.update(builds).set({ status: "processing" }).where(eq(builds.id, id));
    await expect(
      putSnapshot({ db: ctx.db, blobs: ctx.scoped }, build, {
        input: { ...input("home"), tags: ["changed"] },
        png: shot().buffer,
        flake: null,
      }),
    ).rejects.toBeInstanceOf(BuildFinalisedError);
    const [after] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, first.id));
    expect(after).toEqual(before);
  });
});
