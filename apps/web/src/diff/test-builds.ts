import { eq } from "drizzle-orm";
import { setup } from "#/api/test-support";
import { type Build, createBuild, finaliseBuild, getBuild, putSnapshot } from "#/db/builds";
import { snapshots } from "#/db/schema";
import { orgBlobs } from "#/storage/blobs";
import { processBuild } from "./process";

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
};

export type Ctx = Awaited<ReturnType<typeof setup>> & {
  projectId: string;
  orgId: string;
  userId: string;
  scoped: ReturnType<typeof orgBlobs>;
};

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
};

/** Create, fill, finalise and diff one build; returns it as the database holds it afterwards. */
export async function upload(ctx: Ctx, spec: BuildSpec): Promise<Build> {
  const id = await createBuild(ctx.db, ctx.projectId, {
    commitSha: spec.commit,
    branch: spec.branch,
    mergeBaseSha: spec.mergeBase ?? null,
    ancestorShas: spec.ancestors ?? [],
    prNumber: null,
  });
  const open = await getBuild(ctx.db, ctx.projectId, id);
  for (const s of spec.shots) {
    await putSnapshot(
      { db: ctx.db, blobs: ctx.scoped },
      open,
      {
        name: s.name ?? "pricing",
        platform: "linux",
        browser: "chromium",
        viewport: "1280x720",
        theme: "light",
        tags: [],
        diff: s.diff ?? {},
        ignore: s.ignore ?? [],
        fingerprint: s.fingerprint ?? FINGERPRINT,
      },
      s.png.buffer,
    );
  }
  const done = await finaliseBuild(ctx.db, open, spec.shots.length);
  await processBuild({ db: ctx.db, blobs: ctx.scoped }, done);
  return getBuild(ctx.db, ctx.projectId, done.id);
}

export async function rows(ctx: Ctx, build: Build) {
  return ctx.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
}

/** The one shot a single-shot build holds. */
export async function onlyShot(ctx: Ctx, build: Build) {
  const [row] = await rows(ctx, build);
  if (!row) throw new Error("build has no snapshots");
  return row;
}
