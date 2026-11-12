import type { A11y } from "@hackcove/pixelslash-engine/a11y-entry";
import type { Composition } from "@hackcove/pixelslash-engine/composition-entry";
import { readPngSize } from "@hackcove/pixelslash-engine/diff";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { CiUpload } from "#/diff/ci-result";
import { sha256Bytes } from "#/lib/crypto";
import type { BlobStore } from "#/storage/blobs";
import { chunk } from "./chunks";
import { type Db, NotFoundError } from "./db";
import { type SentFlake, labelFlake } from "./flakes";
import { heldShot } from "./markers";
import { snapshotStem } from "./stem";
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
  /** The uploader's brief (PS-232), trimmed; null when none was sent. */
  brief?: string | null;
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
  fingerprint: {
    image: string;
    browser: string;
    fonts: string;
    /** Native only (PS-293): absent on a web shot, so its stored fingerprint is unchanged. */
    platform?: string;
    device?: string;
    scale?: string;
  };
  /** The flaky policy the shot's config gives it (ob 1724); absent or null is `review`. */
  flaky?: FlakyPolicy | null;
  /** The judge's sentence on what changed (ob 1745); shown, never used to decide anything. */
  changeNote?: string | null;
  /** A composition-only project's findings (ob 1850); shown, never used to decide anything. */
  composition?: Composition | null;
  /** The page's accessibility scan (PS-238); null or absent is not scanned. Shown only. */
  a11y?: A11y | null;
};

/** The build exists but can no longer change. */
export class BuildFinalisedError extends Error {
  constructor() {
    super("build is finalised");
    this.name = "BuildFinalisedError";
  }
}

/**
 * A shot was sent by hash and the project holds no image with that hash (PS-424): a 409 with the
 * code `image_unknown`. The CLI then sends that shot with its file.
 */
export class ImageUnknownError extends Error {
  static readonly CODE = "image_unknown";
  readonly code = ImageUnknownError.CODE;
  constructor() {
    super("no image with that sha256 is held by this project: send the PNG");
    this.name = "ImageUnknownError";
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
  /** The shot's size, from its PNG header; null on a shot sent by hash, which takes the held image's. */
  image: { width: number; height: number } | null;
  results: { baselineId: string; status: unknown; diffResult: unknown; mask: ArrayBuffer }[];
};

/** Store each CI mask beside the shot, one per baseline, and return what `ci_results` holds. */
async function putMasks(
  blobs: BlobStore,
  stem: string,
  ci: CiShot & { image: CiUpload["image"] },
): Promise<CiUpload> {
  const results = await Promise.all(
    ci.results.map(async ({ mask, ...result }) => {
      const diffKey = `${stem}.vs-${result.baselineId}.diff.png`;
      await blobs.put(diffKey, mask, "image/png");
      return { ...result, diffKey };
    }),
  );
  return { engineVersion: ci.engineVersion, image: ci.image, results };
}

/**
 * Store the layout metrics file (PS-294) beside the shot and return its key, or null when the shot
 * came without one: a re-upload without metrics clears the key, and the old blob stays under the
 * build and goes with it.
 */
async function putMetrics(
  blobs: BlobStore,
  stem: string,
  metrics: ArrayBuffer | null,
): Promise<string | null> {
  if (!metrics) return null;
  const key = `${stem}.metrics.json`;
  await blobs.put(key, metrics, "application/json");
  return key;
}

/** An image the project already holds, named by the hash of its bytes instead of being sent (PS-424). */
export type HeldImage = { sha256: string };

/** The columns a held image lends the shot that names it. */
type Held = Pick<typeof snapshots.$inferSelect, "imageKey" | "imageSha256" | "imageSize">;

/**
 * The rows of this project's finished builds that hold an image with one of these hashes (PS-424),
 * one per hash. Finished means past `uploading`: `putSnapshot` can still overwrite the blob of a
 * build that is open, and a key shared with another build must never change under it. Scoped to
 * the project (never the org, never another project): a token learns nothing about its siblings.
 * A removed marker holds no image of its own and never matches. The lookup is chunked for D1's
 * 100-parameter limit.
 */
export async function heldImages(
  db: Db,
  projectId: string,
  hashes: readonly string[],
): Promise<Map<string, Held>> {
  const found = new Map<string, Held>();
  // Three more values are bound beside the hashes: the project, `uploading` and `removed`.
  for (const part of chunk(hashes, 3)) {
    const rows = await db
      .select({
        imageKey: snapshots.imageKey,
        imageSha256: snapshots.imageSha256,
        imageSize: snapshots.imageSize,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .where(
        and(
          inArray(snapshots.imageSha256, part),
          eq(builds.projectId, projectId),
          ne(builds.status, "uploading"),
          heldShot(),
        ),
      );
    for (const row of rows)
      if (row.imageSha256 && !found.has(row.imageSha256)) found.set(row.imageSha256, row);
  }
  return found;
}

/** One upload: the shot's meta, its PNG (or the hash of one the project holds) and, from a CI project's CLI, what it measured (ob 1727). */
export type SentSnapshot = {
  input: SnapshotInput;
  png: ArrayBuffer | HeldImage;
  /** The layout metrics file's bytes (PS-294), already checked; absent or null is none. */
  metrics?: ArrayBuffer | null;
  ci?: CiShot | null;
  /** The CLI found the shot flaky (ob 1737): its record and re-captures. */
  flake?: SentFlake | null;
};

/** What a shot carries only to be shown: the judge's note, the composition findings and the a11y scan. */
const shown = (input: SnapshotInput) => ({
  changeNote: input.changeNote ?? null,
  composition: input.composition ?? null,
  a11y: input.a11y ?? null,
});

/** The shot's image: stored under its own stem when it came with its bytes, else the one a hash names. */
async function imageOf(
  { db, blobs }: { db: Db; blobs: BlobStore },
  build: Build,
  stem: string,
  png: ArrayBuffer | HeldImage,
): Promise<Held> {
  if (!(png instanceof ArrayBuffer)) {
    const held = (await heldImages(db, build.projectId, [png.sha256])).get(png.sha256);
    if (!held) throw new ImageUnknownError();
    return held;
  }
  const imageKey = `${stem}.png`;
  await blobs.put(imageKey, png, "image/png");
  return {
    imageKey,
    imageSha256: await sha256Bytes(png),
    imageSize: readPngSize(new Uint8Array(png)),
  };
}

/**
 * What `putSnapshot` writes besides the shot's identity. The image comes first: a hash the project
 * does not hold is refused before anything is written (PS-424).
 */
async function rowFields(
  { db, blobs }: { db: Db; blobs: BlobStore },
  build: Build,
  stem: string,
  { input, png, metrics = null, ci = null, flake = null }: SentSnapshot,
) {
  const image = await imageOf({ db, blobs }, build, stem, png);
  const ciResults = await putCiResults(blobs, stem, ci, image);
  return {
    tags: input.tags,
    diffOptions: input.diff,
    ignore: input.ignore,
    envFingerprint: JSON.stringify(input.fingerprint),
    ...image,
    metricsKey: await putMetrics(blobs, stem, metrics),
    ciResults,
    flakyPolicy: input.flaky ?? flake?.record.policy ?? null,
    ...shown(input),
  };
}

/**
 * A CI project's results with their masks stored, sized by the CLI's image or, for a shot sent by
 * hash, by the held image. A held image with no recorded size cannot be checked against its masks:
 * the shot is refused so the client sends the PNG.
 */
async function putCiResults(
  blobs: BlobStore,
  stem: string,
  ci: CiShot | null,
  image: Held,
): Promise<CiUpload | null> {
  if (!ci) return null;
  const size = ci.image ?? image.imageSize;
  if (!size) throw new ImageUnknownError();
  return putMasks(blobs, stem, { ...ci, image: size });
}

/**
 * Store a snapshot's PNG and its row. Sending the same name + variant again replaces it:
 * the blob key comes from that identity, so the second PNG overwrites the first in place.
 * The blob goes first, so a failed put leaves no row to count.
 *
 * A shot sent by hash (PS-424) has no PNG: its row takes `imageKey`, `imageSha256` and `imageSize`
 * from a finished build of the same project that holds that hash, and everything else (masks,
 * metrics, flake captures) is stored under the shot's own stem as for any shot. With no such
 * build it throws `ImageUnknownError` before anything is written. A hash is never trusted for
 * bytes the server received: a shot sent with its PNG is hashed here.
 */
export async function putSnapshot(
  { db, blobs }: { db: Db; blobs: BlobStore },
  build: Build,
  sent: SentSnapshot,
): Promise<{ id: string }> {
  if (build.status !== "uploading") throw new BuildFinalisedError();
  const { name, platform, browser, viewport, theme } = sent.input;
  const stem = await snapshotStem({ buildId: build.id, name, platform, browser, viewport, theme });
  const fields = await rowFields({ db, blobs }, build, stem, sent);
  const { flake = null } = sent;
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
    {
      id: row.id,
      buildId: build.id,
      projectId: build.projectId,
      key,
      imageKey: fields.imageKey,
      stem,
    },
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
