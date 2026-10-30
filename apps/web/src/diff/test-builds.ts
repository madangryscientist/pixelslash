import type { diffPngs } from "@pixelslash/engine/diff";
import { eq } from "drizzle-orm";
import { setup } from "#/api/test-support";
import { type Build, createBuild, finaliseBuild, getBuild, putSnapshot } from "#/db/builds";
import type { Db } from "#/db/db";
import type { SentFlake } from "#/db/flakes";
import { type FlakyPolicy, snapshots } from "#/db/schema";
import { TEST_MODEL_KEY_SECRET } from "#/db/test-db";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import type { ConsumerDeps } from "#/ai/explain-queue";
import { type MemoryQueue, memoryQueue } from "#/ai/explain-queue-kit";
import type { ModelFetch } from "#/ai/model";
import { type ProcessDeps, processBuild } from "./process";

/** Uploading and diffing whole builds, as the CI API does. Tests only. */

export const FINGERPRINT = { image: "version:1", browser: "chromium 148", fonts: "sha256:f" };

/** A 40-character hex SHA, distinct per `n`. */
export const sha = (n: number) => n.toString(16).padStart(40, "0");

export type Shot = {
  name?: string;
  png: Uint8Array<ArrayBuffer>;
  fingerprint?: { image: string; browser: string; fonts: string };
  diff?: object;
  ignore?: Array<{ x: number; y: number; width: number; height: number }>;
  flaky?: FlakyPolicy | null;
  flake?: SentFlake | null;
};

export type Ctx = Awaited<ReturnType<typeof setup>> & {
  projectId: string;
  orgId: string;
  userId: string;
  scoped: ReturnType<typeof orgBlobs>;
};

/** What uploading a build needs: a store, a project and its blobs, on any database (ob 1773: a local D1 too). */
export type Uploads = Pick<Ctx, "projectId" | "scoped"> & { db: Db };

export async function context(): Promise<Ctx> {
  const held = await setup();
  return {
    ...held,
    projectId: held.acme.project.id,
    orgId: held.acme.org.id,
    userId: held.acme.user.id,
    scoped: orgBlobs(held.deps.store, held.acme.org.id),
  };
}

export type BuildSpec = {
  branch: string;
  commit: string;
  mergeBase?: string;
  ancestors?: string[];
  shots: Shot[];
  /** The uploader's brief (PS-232). */
  brief?: string;
};

const createArgs = (spec: BuildSpec) => ({
  commitSha: spec.commit,
  branch: spec.branch,
  mergeBaseSha: spec.mergeBase ?? null,
  ancestorShas: spec.ancestors ?? [],
  prNumber: null,
  brief: spec.brief ?? null,
});

/** Create a build and send its shots, as a client does before it finalises. */
async function open(ctx: Uploads, spec: BuildSpec): Promise<Build> {
  const id = await createBuild(ctx.db, ctx.projectId, createArgs(spec));
  const build = await getBuild(ctx.db, ctx.projectId, id);
  for (const s of spec.shots) {
    await putSnapshot({ db: ctx.db, blobs: ctx.scoped }, build, {
      input: {
        name: s.name ?? "pricing",
        platform: "linux",
        browser: "chromium",
        viewport: "1280x720",
        theme: "light",
        tags: [],
        diff: s.diff ?? {},
        ignore: s.ignore ?? [],
        fingerprint: s.fingerprint ?? FINGERPRINT,
        flaky: s.flaky ?? null,
      },
      png: s.png.buffer,
      flake: s.flake ?? null,
    });
  }
  return build;
}

/** A test that names no model transport reaches none: the call fails instead of going out. */
const noModel: ModelFetch = () => Promise.reject(new Error("no model transport in this test"));

/** The explain queue's consumer for a test: the test's one org store, and no real model. */
export const consumerDeps = ({
  db,
  blobs,
  now,
  modelFetch,
  modelKeySecret = TEST_MODEL_KEY_SECRET,
}: {
  db: Db;
  blobs: BlobStore;
  now?: (() => number) | undefined;
  modelFetch?: ModelFetch | undefined;
  modelKeySecret?: string | undefined;
}): ConsumerDeps => ({
  db,
  blobs: () => blobs,
  now,
  modelFetch: modelFetch ?? noModel,
  modelKeySecret,
});

/** Run a diff (a finalise, a re-run) with an explain queue, then drain it, as the Worker would. */
export async function explaining<T>(
  deps: Parameters<typeof consumerDeps>[0],
  run: (deps: ProcessDeps) => Promise<T>,
): Promise<T> {
  const explain = memoryQueue();
  const { db, blobs, now, modelKeySecret = TEST_MODEL_KEY_SECRET } = deps;
  const result = await run({ db, blobs, now, modelKeySecret, explainQueue: explain.queue });
  await explain.drain(consumerDeps(deps));
  return result;
}

/**
 * Create, fill, finalise and diff one build; returns it as the database holds it afterwards.
 * `now` is the clock the diff measures its budget with; `db` puts a store of the test's own in
 * front of the diff only, so a failure there is not the store the assertions read back from;
 * `blobs` does the same for the images; `diff` stands in for the engine's diff; `diffSidecar` names
 * a diff sidecar (PS-203); `modelFetch` for
 * the project's model. The explain queue (ob 1875) is drained before it returns, unless the test
 * passes its own `queue` to drain when it chooses.
 */
export async function upload(
  ctx: Uploads,
  spec: BuildSpec,
  {
    now,
    db = ctx.db,
    blobs = ctx.scoped,
    diff,
    diffSidecar,
    modelFetch,
    modelKeySecret = TEST_MODEL_KEY_SECRET,
    queue,
  }: {
    now?: () => number;
    db?: Db;
    blobs?: BlobStore;
    diff?: typeof diffPngs | undefined;
    diffSidecar?: string | undefined;
    modelFetch?: ModelFetch | undefined;
    /** What opens the project's model key; `null` runs the server without `MODEL_KEY_SECRET`. */
    modelKeySecret?: string | null;
    queue?: MemoryQueue;
  } = {},
): Promise<Build> {
  const done = await finaliseBuild(ctx.db, await open(ctx, spec), spec.shots.length);
  const explain = queue ?? memoryQueue();
  const secret = modelKeySecret ?? undefined;
  await processBuild(
    { db, blobs, now, diff, diffSidecar, explainQueue: explain.queue, modelKeySecret: secret },
    done,
  );
  if (!queue)
    await explain.drain(consumerDeps({ db, blobs, now, modelFetch, modelKeySecret: secret }));
  return getBuild(ctx.db, ctx.projectId, done.id);
}

export async function rows(ctx: Uploads, build: Build) {
  return ctx.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
}

/** The one shot a single-shot build holds. */
export async function onlyShot(ctx: Uploads, build: Build) {
  const [row] = await rows(ctx, build);
  if (!row) throw new Error("build has no snapshots");
  return row;
}
