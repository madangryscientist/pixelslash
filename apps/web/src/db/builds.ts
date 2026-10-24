import type { Composition } from "@pixelslash/engine/composition-entry";
import { and, count, eq } from "drizzle-orm";
import type { CiUpload } from "#/diff/ci-result";
import { sha256Hex } from "#/lib/crypto";
import type { BlobStore } from "#/storage/blobs";
import { type Db, NotFoundError } from "./db";
import { type SentFlake, labelFlake } from "./flakes";
import { heldShot } from "./markers";
import {
  type BuildTimings,
  type DiffOptions,
  type FlakyPolicy,
  type IgnoreRect,
  builds,
  snapshots,
} from "./schema";

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
  /** The flaky policy the shot's config gives it (ob 1724); absent or null is `review`. */
  flaky?: FlakyPolicy | null;
  /** The judge's sentence on what changed (ob 1745); shown, never used to decide anything. */
  changeNote?: string | null;
  /** A composition-only project's findings (ob 1850); shown, never used to decide anything. */
  composition?: Composition | null;
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
 * What a CLI in a `ci` project sent with a shot (ob 1727): per baseline it measured against, the
 * result and its diff mask. Stored unchecked as `CiUpload`; finalise checks the server's pick.
 */
export type CiShot = {
  engineVersion: string;
  /** The shot's size, from its PNG header. */
  image: { width: number; height: number };
  results: { baselineId: string; status: unknown; diffResult: unknown; mask: ArrayBuffer }[];
};

/** Store each CI mask beside the shot, one per baseline, and return what `ci_results` holds. */
async function putMasks(blobs: BlobStore, stem: string, ci: CiShot): Promise<CiUpload> {
  const results = await Promise.all(
    ci.results.map(async ({ mask, ...result }) => {
      const diffKey = `${stem}.vs-${result.baselineId}.diff.png`;
      await blobs.put(diffKey, mask, "image/png");
      return { ...result, diffKey };
    }),
  );
  return { engineVersion: ci.engineVersion, image: ci.image, results };
}

/** One upload: the shot's meta, its PNG and, from a CI project's CLI, what it measured (ob 1727). */
export type SentSnapshot = {
  input: SnapshotInput;
  png: ArrayBuffer;
  ci?: CiShot | null;
  /** The CLI found the shot flaky (ob 1737): its record and re-captures. */
  flake?: SentFlake | null;
};

/** What a shot carries only to be shown: the judge's note and the composition findings. */
const shown = (input: SnapshotInput) => ({
  changeNote: input.changeNote ?? null,
  composition: input.composition ?? null,
});

/**
 * Store a snapshot's PNG and its row. Sending the same name + variant again replaces it:
 * the blob key comes from that identity, so the second PNG overwrites the first in place.
 * The blob goes first, so a failed put leaves no row to count.
 */
export async function putSnapshot(
  { db, blobs }: { db: Db; blobs: BlobStore },
  build: Build,
  { input, png, ci = null, flake = null }: SentSnapshot,
): Promise<{ id: string }> {
  if (build.status !== "uploading") throw new BuildFinalisedError();
  const { name, platform, browser, viewport, theme } = input;
  const identity = await sha256Hex(JSON.stringify([name, platform, browser, viewport, theme]));
  const stem = `builds/${build.id}/${identity.slice(0, 32)}`;
  const imageKey = `${stem}.png`;
  await blobs.put(imageKey, png, "image/png");
  const fields = {
    tags: input.tags,
    diffOptions: input.diff,
    ignore: input.ignore,
    envFingerprint: JSON.stringify(input.fingerprint),
    imageKey,
    ciResults: ci && (await putMasks(blobs, stem, ci)),
    flakyPolicy: input.flaky ?? flake?.record.policy ?? null,
    ...shown(input),
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
  const key = { name, platform, browser, viewport, theme };
  await labelFlake(
    { db, blobs },
    { id: row.id, buildId: build.id, projectId: build.projectId, key, imageKey, stem },
    flake,
  );
  return row;
}

/**
 * Close the build to further uploads and hand it to processing. `expected` is how many
 * snapshots the client sent: a short count means an upload was lost, so the build stays open.
 * Finalising twice is fine (a retry after a lost reply); a changed count after that is not.
 */
export async function finaliseBuild(
  db: Db,
  build: Build,
  expected: number,
  timings: BuildTimings | null = null,
): Promise<Build> {
  const [held] = await db
    .select({ n: count() })
    .from(snapshots)
    // Removed markers are written by the diff, not uploaded, so they never count as deliveries.
    .where(and(eq(snapshots.buildId, build.id), heldShot()));
  const actual = held?.n ?? 0;
  if (actual !== expected) throw new SnapshotCountError(expected, actual);
  // A retry after a lost reply: the build already moved on and is being, or has been, diffed.
  if (build.status !== "uploading") return build;
  await db
    .update(builds)
    .set({ status: "processing", timings })
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
