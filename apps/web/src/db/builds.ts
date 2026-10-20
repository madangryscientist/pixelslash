import { and, count, eq } from "drizzle-orm";
import { sha256Hex } from "#/lib/crypto";
import type { BlobStore } from "#/storage/blobs";
import { type Db, NotFoundError } from "./db";
import { type DiffOptions, type IgnoreRect, builds, snapshots } from "./schema";

export type Build = typeof builds.$inferSelect;

export type NewBuild = {
  commitSha: string;
  branch: string;
  mergeBaseSha: string | null;
  ancestorShas: string[];
  prNumber: number | null;
};

/** What a snapshot is: a name and a fixed variant, plus what rendered it. */
export type SnapshotInput = {
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
  tags: string[];
  diff: DiffOptions;
  ignore: IgnoreRect[];
  fingerprint: { image: string; browser: string; fonts: string };
};

/** The build exists but can no longer change. */
export class BuildFinalisedError extends Error {
  constructor() {
    super("build is finalised");
    this.name = "BuildFinalisedError";
  }
}

/** Finalise named a snapshot count the build does not hold. */
export class SnapshotCountError extends Error {
  constructor(expected: number, actual: number) {
    super(`build holds ${actual} snapshots, finalise expected ${expected}`);
    this.name = "SnapshotCountError";
  }
}

export async function createBuild(db: Db, projectId: string, input: NewBuild): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(builds).values({ id, projectId, ...input });
  return id;
}

/** Scoped to the project: another project's build is the same 404 as a missing one. */
export async function getBuild(db: Db, projectId: string, buildId: string): Promise<Build> {
  const [row] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("build");
  return row;
}

/**
 * Store a snapshot's PNG and its row. Sending the same name + variant again replaces it:
 * the blob key comes from that identity, so the second PNG overwrites the first in place.
 * The blob goes first, so a failed put leaves no row to count.
 */
export async function putSnapshot(
  { db, blobs }: { db: Db; blobs: BlobStore },
  build: Build,
  input: SnapshotInput,
  png: ArrayBuffer,
): Promise<{ id: string }> {
  if (build.status !== "uploading") throw new BuildFinalisedError();
  const { name, platform, browser, viewport, theme } = input;
  const identity = await sha256Hex(JSON.stringify([name, platform, browser, viewport, theme]));
  const imageKey = `builds/${build.id}/${identity.slice(0, 32)}.png`;
  await blobs.put(imageKey, png, "image/png");
  const fields = {
    tags: input.tags,
    diffOptions: input.diff,
    ignore: input.ignore,
    envFingerprint: JSON.stringify(input.fingerprint),
    imageKey,
  };
  const [row] = await db
    .insert(snapshots)
    .values({
      id: crypto.randomUUID(),
      buildId: build.id,
      name,
      platform,
      browser,
      viewport,
      theme,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [
        snapshots.buildId,
        snapshots.name,
        snapshots.platform,
        snapshots.browser,
        snapshots.viewport,
        snapshots.theme,
      ],
      set: fields,
    })
    .returning({ id: snapshots.id });
  if (!row) throw new Error("snapshot upsert returned nothing");
  return row;
}

/**
 * Close the build to further uploads and hand it to processing. `expected` is how many
 * snapshots the client sent: a short count means an upload was lost, so the build stays open.
 * Finalising twice is fine (a retry after a lost reply); a changed count after that is not.
 */
export async function finaliseBuild(db: Db, build: Build, expected: number): Promise<Build> {
  const [held] = await db
    .select({ n: count() })
    .from(snapshots)
    .where(eq(snapshots.buildId, build.id));
  const actual = held?.n ?? 0;
  if (actual !== expected) throw new SnapshotCountError(expected, actual);
  if (build.status !== "uploading") return build;
  await db
    .update(builds)
    .set({ status: "processing" })
    .where(and(eq(builds.id, build.id), eq(builds.status, "uploading")));
  return getBuild(db, build.projectId, build.id);
}

/**
 * The diff options a snapshot is to be compared with, as the customer's config resolved them at
 * upload. Keys left out take the engine default. The server diff reads them here.
 */
export async function snapshotDiffOptions(db: Db, snapshotId: string): Promise<DiffOptions> {
  const [row] = await db
    .select({ diffOptions: snapshots.diffOptions })
    .from(snapshots)
    .where(eq(snapshots.id, snapshotId));
  if (!row) throw new NotFoundError("snapshot");
  return row.diffOptions;
}

/** The areas a snapshot's diff skips, as sent at upload: image px, `[]` when none. */
export async function snapshotIgnore(db: Db, snapshotId: string): Promise<IgnoreRect[]> {
  const [row] = await db
    .select({ ignore: snapshots.ignore })
    .from(snapshots)
    .where(eq(snapshots.id, snapshotId));
  if (!row) throw new NotFoundError("snapshot");
  return row.ignore;
}
