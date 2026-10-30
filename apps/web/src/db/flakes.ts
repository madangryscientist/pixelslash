import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BlobStore } from "#/storage/blobs";
import type { SnapshotKey } from "./baselines";
import { type Db, NotFoundError } from "./db";
import { getProject } from "./orgs";
import { refreshBuildStatus } from "./review";
import {
  type DiffRegion,
  type FlakeEvidence,
  type FlakyPolicy,
  builds,
  flakes,
  snapshots,
  users,
} from "./schema";

/**
 * Flakes (ob 1724): a snapshot key whose captures disagreed within one run (the CLI's `meta.flake`,
 * ob 1737), or one a reviewer marked flaky by hand. One row per key per project; what a flaky shot
 * does to its build is its own config's `flaky` policy, never a server setting.
 */

/** `meta.flake` as validated: the CLI's record, without the re-captures it names. */
export type FlakeInput = {
  runs: number;
  differed: number[];
  regions: { run: number; regions: DiffRegion[] }[];
  engineVersion: string;
  policy: FlakyPolicy;
};

/** What an upload sent about a flaky shot: the record and the re-captures that were PNGs. */
export type SentFlake = { record: FlakeInput; captures: { run: number; png: ArrayBuffer }[] };

const keyOf = (projectId: string, key: SnapshotKey) =>
  and(
    eq(flakes.projectId, projectId),
    eq(flakes.name, key.name),
    eq(flakes.platform, key.platform),
    eq(flakes.browser, key.browser),
    eq(flakes.viewport, key.viewport),
    eq(flakes.theme, key.theme),
  );

const REOPENED = {
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
} as const;

/**
 * Open the key's flake, or reopen it, and return its id. Evidence for a shot replaces the evidence
 * that shot sent before (an upload sent again), and is appended otherwise. A hand mark keeps who
 * marked it first and the note it was marked with.
 */
async function openFlake(
  db: Db,
  projectId: string,
  key: SnapshotKey,
  add: { evidence?: FlakeEvidence; by?: string; note?: string | null },
): Promise<string> {
  const now = new Date();
  await db
    .insert(flakes)
    .values({ id: crypto.randomUUID(), projectId, ...key, updatedAt: now })
    .onConflictDoNothing();
  const [row] = await db.select().from(flakes).where(keyOf(projectId, key));
  if (!row) throw new Error("flake upsert returned nothing");
  const { evidence } = add;
  await db
    .update(flakes)
    .set({
      ...REOPENED,
      evidence: evidence
        ? [...row.evidence.filter((e) => e.snapshotId !== evidence.snapshotId), evidence]
        : row.evidence,
      createdBy: row.createdBy ?? add.by ?? null,
      note: row.note ?? add.note ?? null,
      updatedAt: now,
    })
    .where(eq(flakes.id, row.id));
  return row.id;
}

/** The key's open flake, if it has one: a shot uploaded while it is open is labelled with it. */
async function openFlakeOf(db: Db, projectId: string, key: SnapshotKey): Promise<string | null> {
  const [row] = await db
    .select({ id: flakes.id })
    .from(flakes)
    .where(and(keyOf(projectId, key), eq(flakes.status, "open")));
  return row?.id ?? null;
}

/**
 * Label a shot just stored (ob 1724). A flake record opens or reopens the key's flake with this
 * build's evidence, the re-captures stored beside the shot; without one the shot takes the key's
 * open flake, if any, until a reviewer resolves it.
 */
export async function labelFlake(
  { db, blobs }: { db: Db; blobs: BlobStore },
  shot: {
    id: string;
    buildId: string;
    projectId: string;
    key: SnapshotKey;
    imageKey: string;
    stem: string;
  },
  flake: SentFlake | null,
): Promise<void> {
  let flakeId: string | null;
  if (flake) {
    const captures = await Promise.all(
      flake.captures.map(async ({ run, png }) => {
        const key = `${shot.stem}.flake-run${run}.png`;
        await blobs.put(key, png, "image/png");
        return { run, key };
      }),
    );
    flakeId = await openFlake(db, shot.projectId, shot.key, {
      evidence: {
        buildId: shot.buildId,
        snapshotId: shot.id,
        imageKey: shot.imageKey,
        captures,
        ...flake.record,
        at: Date.now(),
      },
    });
  } else {
    flakeId = await openFlakeOf(db, shot.projectId, shot.key);
  }
  await db.update(snapshots).set({ flakeId }).where(eq(snapshots.id, shot.id));
}

/**
 * A reviewer marks a shot flaky by hand: the key's flake opens (or reopens) with no CLI evidence,
 * and the shot is labelled with it. Its config's policy then applies, so the build's verdict is
 * read again. A member of the project's org only; anything else is the same 404. Returns the flake
 * and the shot's build, whose check run is synced (PS-23).
 */
export async function markFlaky(
  db: Db,
  input: { userId: string; projectId: string; snapshotId: string; note: string | null },
): Promise<{ flakeId: string; buildId: string }> {
  await getProject(db, input.userId, input.projectId);
  const [shot] = await db
    .select({
      buildId: snapshots.buildId,
      status: builds.status,
      name: snapshots.name,
      platform: snapshots.platform,
      browser: snapshots.browser,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, input.snapshotId), eq(builds.projectId, input.projectId)));
  if (!shot) throw new NotFoundError("snapshot");
  const { buildId, status, ...key } = shot;
  const flakeId = await openFlake(db, input.projectId, key, {
    by: input.userId,
    note: input.note,
  });
  await db.update(snapshots).set({ flakeId }).where(eq(snapshots.id, input.snapshotId));
  if (status === "changes" || status === "passed") await refreshBuildStatus(db, buildId);
  return { flakeId, buildId };
}

/** The project a flake belongs to, for the caller to check the actor may reach it. */
export async function flakeProjectId(db: Db, flakeId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: flakes.projectId })
    .from(flakes)
    .where(eq(flakes.id, flakeId));
  if (!row) throw new NotFoundError("flake");
  return row.projectId;
}

/**
 * Resolve a flake, with who and an optional note. The caller has checked the user may reach the
 * project. Shots already labelled keep their label, as history; later uploads are not labelled
 * until the key is detected or marked again.
 */
export async function resolveFlake(
  db: Db,
  input: { projectId: string; flakeId: string; userId: string; note: string | null },
): Promise<void> {
  const done = await db
    .update(flakes)
    .set({
      status: "resolved",
      resolvedBy: input.userId,
      resolvedAt: new Date(),
      resolutionNote: input.note,
      updatedAt: new Date(),
    })
    .where(and(eq(flakes.id, input.flakeId), eq(flakes.projectId, input.projectId)))
    .returning({ id: flakes.id });
  if (done.length === 0) throw new NotFoundError("flake");
}

/** Reopen a resolved flake by hand from the Flakes list. */
export async function reopenFlake(
  db: Db,
  input: { projectId: string; flakeId: string },
): Promise<void> {
  const done = await db
    .update(flakes)
    .set({ ...REOPENED, updatedAt: new Date() })
    .where(and(eq(flakes.id, input.flakeId), eq(flakes.projectId, input.projectId)))
    .returning({ id: flakes.id });
  if (done.length === 0) throw new NotFoundError("flake");
}

/** Resolve or reopen as a member of the project's org, from the web app. */
export async function setFlakeStatus(
  db: Db,
  input: { userId: string; projectId: string; flakeId: string; open: boolean; note: string | null },
): Promise<void> {
  await getProject(db, input.userId, input.projectId);
  if (input.open) await reopenFlake(db, input);
  else await resolveFlake(db, input);
}

export type ProjectFlake = {
  id: string;
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
  status: "open" | "resolved";
  evidence: FlakeEvidence[];
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  updatedAt: Date;
};

const creator = alias(users, "creator");
const resolver = alias(users, "resolver");

/** A flake as a reader sees it, with the reviewers as logins. */
function selectFlakes(db: Db) {
  return db
    .select({
      id: flakes.id,
      name: flakes.name,
      platform: flakes.platform,
      browser: flakes.browser,
      viewport: flakes.viewport,
      theme: flakes.theme,
      status: flakes.status,
      evidence: flakes.evidence,
      note: flakes.note,
      createdBy: creator.login,
      createdAt: flakes.createdAt,
      resolvedBy: resolver.login,
      resolvedAt: flakes.resolvedAt,
      resolutionNote: flakes.resolutionNote,
      updatedAt: flakes.updatedAt,
    })
    .from(flakes)
    .leftJoin(creator, eq(creator.id, flakes.createdBy))
    .leftJoin(resolver, eq(resolver.id, flakes.resolvedBy));
}

/** Every flake of the project: open ones first, then the most recently touched. */
export async function projectFlakes(db: Db, projectId: string): Promise<ProjectFlake[]> {
  return selectFlakes(db)
    .where(eq(flakes.projectId, projectId))
    .orderBy(
      asc(sql`case when ${flakes.status} = 'open' then 0 else 1 end`),
      desc(flakes.updatedAt),
      asc(flakes.id),
    );
}

/** The project's flakes for the web app: a member of the project's org only. */
export async function listFlakes(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ProjectFlake[]> {
  await getProject(db, userId, projectId);
  return projectFlakes(db, projectId);
}

/** One flake of the project, for the snapshot page; null when the shot is not labelled. */
export async function projectFlake(
  db: Db,
  projectId: string,
  flakeId: string | null,
): Promise<ProjectFlake | null> {
  if (!flakeId) return null;
  const [row] = await selectFlakes(db).where(
    and(eq(flakes.id, flakeId), eq(flakes.projectId, projectId)),
  );
  return row ?? null;
}
