import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { ImageUnknownError } from "#/db/builds";
import { snapshots } from "#/db/schema";
import { diffKeyOf } from "./compare";
import { type Shot, context, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A shot stored by hash (PS-424) shares another build's image blob but is a shot of its own: its
 * row, counts and diff read as a build sent with files, and nothing it writes lands on a key
 * another build reads.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

const main = { branch: "main", commit: sha(1), shots: [{ name: "a", png: white }] as Shot[] };
/** Each commit on a branch of its own, so every build is measured against main and none against the last. */
const onFeat = (commit: number, shots: Shot[]) => ({
  branch: `feat-${commit}`,
  commit: sha(commit),
  mergeBase: sha(1),
  shots,
});

describe("a build sent by hash", () => {
  test("reads the same as a build sent with files: rows, counts, verdict and diff", async () => {
    const ctx = await context();
    await upload(ctx, main);
    const withFiles = await upload(ctx, onFeat(2, [{ name: "a", png: red }]));
    // The same image again, by hash only: the project holds it from the build above.
    const byHash = await upload(ctx, onFeat(3, [{ name: "a", png: red, byHash: true }]));

    const files = await onlyShot(ctx, withFiles);
    const hashed = await onlyShot(ctx, byHash);
    expect(byHash.status).toBe(withFiles.status);
    expect(hashed.imageSha256).toBe(files.imageSha256);
    expect(hashed.imageSize).toEqual(files.imageSize);
    // The blob is the other build's; the second build stored no PNG of its own.
    expect(hashed.imageKey).toBe(files.imageKey);
    expect(hashed.diffStatus).toBe(files.diffStatus);
    expect(hashed.diffStatus).toBe("changed");
    expect(hashed.diffResult).toEqual(files.diffResult);
    expect(hashed.reviewState).toBe(files.reviewState);
    expect((await rows(ctx, byHash)).length).toBe((await rows(ctx, withFiles)).length);
    // Under its own folder the build wrote its overlay and no PNG.
    expect([...ctx.blobs.data.keys()].filter((k) => k.includes(`/builds/${byHash.id}/`))).toEqual([
      `orgs/${ctx.orgId}/${hashed.diffKey}`,
    ]);
  });

  test("two builds sharing an image get different diff keys, and each overlay is its own blob", async () => {
    const ctx = await context();
    await upload(ctx, main);
    const first = await upload(ctx, onFeat(2, [{ name: "a", png: red }]));
    const second = await upload(ctx, onFeat(3, [{ name: "a", png: red, byHash: true }]));
    const a = await onlyShot(ctx, first);
    const b = await onlyShot(ctx, second);
    expect(a.imageKey).toBe(b.imageKey);
    expect(a.diffKey).toBeTruthy();
    expect(b.diffKey).toBeTruthy();
    expect(a.diffKey).not.toBe(b.diffKey);
    expect(a.diffKey).toBe(diffKeyOf(a.imageKey.replace(/\.png$/, "")));
    expect(b.diffKey).toContain(`builds/${second.id}/`);
    for (const row of [a, b]) expect(await ctx.scoped.get(row.diffKey ?? "")).not.toBeNull();
  });

  test("a project that holds no such image refuses the hash and stores nothing", async () => {
    const ctx = await context();
    await expect(upload(ctx, onFeat(2, [{ name: "a", png: red, byHash: true }]))).rejects.toThrow(
      ImageUnknownError,
    );
    expect(await ctx.db.select().from(snapshots)).toEqual([]);
    expect(ctx.blobs.data.size).toBe(0);
  });

  test("a hash held only by a build still uploading is not matched", async () => {
    const ctx = await context();
    const { createBuild, getBuild, putSnapshot } = await import("#/db/builds");
    const open = await getBuild(
      ctx.db,
      ctx.projectId,
      await createBuild(ctx.db, ctx.projectId, {
        commitSha: sha(5),
        branch: "feat",
        mergeBaseSha: null,
        ancestorShas: [],
        prNumber: null,
      }),
    );
    const input = {
      name: "a",
      platform: "linux",
      browser: "chromium",
      viewport: "1280x720",
      theme: "light",
      tags: [],
      diff: {},
      ignore: [],
      fingerprint: { image: "version:1", browser: "chromium 148", fonts: "sha256:f" },
    };
    await putSnapshot({ db: ctx.db, blobs: ctx.scoped }, open, { input, png: red.buffer });
    await expect(upload(ctx, onFeat(6, [{ name: "a", png: red, byHash: true }]))).rejects.toThrow(
      ImageUnknownError,
    );
    expect(
      await ctx.db.select().from(snapshots).where(eq(snapshots.buildId, open.id)),
    ).toHaveLength(1);
  });
});
