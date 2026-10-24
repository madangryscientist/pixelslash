import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { buildView } from "#/db/review";
import { builds, snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { processBuild } from "./process";
import { rediffShots } from "./rerun";
import { type Ctx, context, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * The same bytes as the baseline are unchanged without being read, decoded or drawn (ob 1948): the
 * uploads' hashes say so. A shot with no hash is read like any other, and the engine's own
 * byte-equal check still saves its overlay.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** The same pixels in other bytes: a different deflate level, so the files differ. */
const reEncoded = new Uint8Array(
  PNG.sync.write(PNG.sync.read(Buffer.from(white)), { deflateLevel: 0 }),
);

/** The store under `ctx`, counting what is read from it and what is written. */
function counting(ctx: Ctx) {
  const gets: string[] = [];
  const puts: string[] = [];
  const blobs: BlobStore = {
    ...ctx.scoped,
    get: (key) => {
      gets.push(key);
      return ctx.scoped.get(key);
    },
    put: (key, body, type) => {
      puts.push(key);
      return ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, gets, puts };
}

const branchSpec = (png: typeof white) => ({
  branch: "feat/x",
  commit: sha(2),
  mergeBase: sha(1),
  shots: [{ png }],
});

describe("identical bytes", () => {
  test("equal hashes: unchanged, diffKey null, no blob read and no overlay written", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const store = counting(ctx);
    const branch = await upload(ctx, branchSpec(white), { blobs: store.blobs });
    const row = await onlyShot(ctx, branch);
    expect(branch.status).toBe("passed");
    expect(row).toMatchObject({ diffStatus: "unchanged", diffKey: null, measuredBy: "server" });
    expect(row.diffResult).toMatchObject({
      changedPixels: 0,
      regions: [],
      sizeChanged: false,
      settledBy: "identical-bytes",
      mainWidth: 64,
      branchHeight: 48,
    });
    expect(store.gets).toEqual([]);
    expect(store.puts.filter((key) => key.endsWith(".diff.png"))).toEqual([]);
  });

  test("a hash is stored with the size at upload", async () => {
    const ctx = await context();
    const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const row = await onlyShot(ctx, main);
    expect(row.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.imageSize).toEqual({ width: 64, height: 48 });
  });

  test("a baseline without a hash falls back to the engine's byte-equal check", async () => {
    const ctx = await context();
    const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    await ctx.db.update(snapshots).set({ imageSha256: null }).where(eq(snapshots.buildId, main.id));
    const store = counting(ctx);
    const branch = await upload(ctx, branchSpec(white), { blobs: store.blobs });
    const row = await onlyShot(ctx, branch);
    expect(row).toMatchObject({ diffStatus: "unchanged", diffKey: null });
    expect(row.diffResult?.settledBy).toBe("identical-bytes");
    // Both images were read, and still no overlay was drawn or written.
    expect(store.gets).toHaveLength(2);
    expect(store.puts.filter((key) => key.endsWith(".diff.png"))).toEqual([]);
  });

  test("a different shot takes the full path and stores its overlay", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const store = counting(ctx);
    const branch = await upload(ctx, branchSpec(red), { blobs: store.blobs });
    const row = await onlyShot(ctx, branch);
    expect(row.diffStatus).toBe("changed");
    expect(row.diffKey).toMatch(/\.diff\.png$/);
    expect(row.diffResult?.settledBy).toBeUndefined();
    expect(store.gets).toHaveLength(2);
  });

  test("other bytes with the same pixels take the full path and come out unchanged", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    expect(Buffer.from(reEncoded).equals(Buffer.from(white))).toBe(false);
    const store = counting(ctx);
    const branch = await upload(ctx, branchSpec(reEncoded), { blobs: store.blobs });
    const row = await onlyShot(ctx, branch);
    expect(row).toMatchObject({ diffStatus: "unchanged" });
    expect(row.diffResult).toMatchObject({ changedPixels: 0, regions: [] });
    expect(row.diffResult?.settledBy).toBeUndefined();
    expect(row.diffKey).toMatch(/\.diff\.png$/);
    expect(store.gets).toHaveLength(2);
  });

  test("measuring again drops the overlay an earlier measurement wrote", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, branchSpec(reEncoded));
    const measured = await onlyShot(ctx, branch);
    const overlay = measured.diffKey ?? "";
    expect(await ctx.scoped.get(overlay)).not.toBeNull();

    // The shot's hash now says it is main's bytes, and it is measured again.
    const [main] = await ctx.db.select().from(snapshots).where(eq(snapshots.diffStatus, "new"));
    await ctx.db
      .update(snapshots)
      .set({
        imageSha256: main?.imageSha256 ?? null,
        imageSize: main?.imageSize ?? null,
        diffStatus: null,
      })
      .where(eq(snapshots.id, measured.id));
    await ctx.db.update(builds).set({ status: "errored" }).where(eq(builds.id, branch.id));
    const again = await getBuild(ctx.db, ctx.projectId, branch.id);
    await processBuild({ db: ctx.db, blobs: ctx.scoped }, again);
    const row = await onlyShot(ctx, branch);
    expect(row).toMatchObject({ diffStatus: "unchanged", diffKey: null });
    expect(await ctx.scoped.get(overlay)).toBeNull();
  });

  test("carry (ob 1712) is as before: identical to an undecided change carries it, without reading it", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const first = await upload(ctx, branchSpec(red));
    const firstShot = await onlyShot(ctx, first);
    const store = counting(ctx);
    const second = await upload(ctx, branchSpec(red), { blobs: store.blobs });
    expect(await onlyShot(ctx, second)).toMatchObject({
      diffStatus: "unchanged",
      diffKey: null,
      baselineKey: firstShot.imageKey,
      carriedFrom: firstShot.id,
      reviewState: "pending",
    });
    expect(second.status).toBe("changes");
    // Only the against-main measurement (ob 1723, red against main's white) reads images.
    expect(store.gets).not.toContain(firstShot.imageKey);
    expect(store.gets).toHaveLength(2);
    expect(store.puts.filter((key) => key.endsWith(".diff.png"))).toEqual([]);
  });

  test("a re-run of an identical shot measures it again to the same result", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, branchSpec(white));
    const before = await onlyShot(ctx, branch);
    const store = counting(ctx);
    await rediffShots({ db: ctx.db, blobs: store.blobs }, branch, [before.id]);
    const after = (await rows(ctx, branch)).find((row) => row.id === before.id);
    expect(after).toMatchObject({
      diffStatus: "unchanged",
      diffKey: null,
      reviewState: before.reviewState,
    });
    expect(after?.diffResult).toEqual(before.diffResult);
    expect(store.gets).toEqual([]);
  });

  test("the build view holds a shot with no diff blob, marked as settled by its bytes", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, branchSpec(white));
    const view = await buildView(ctx.db, ctx.projectId, branch.id);
    const [only] = view.snapshots;
    expect(view.snapshots).toHaveLength(1);
    expect(only).toMatchObject({ diffStatus: "unchanged", diffKey: null });
    expect(only?.diffResult?.settledBy).toBe("identical-bytes");
  });
});
