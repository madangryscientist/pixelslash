import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { type Db, NotFoundError } from "./db";
import { getProject } from "./orgs";
import { type FlagKind, type IgnoreRect, builds, detectionFlags, snapshots, users } from "./schema";

/**
 * Detection flags (ob 1721): a reviewer's word that the diff got a shot wrong. Every call checks
 * the user is a member of the project's org, and that the snapshot is in the project: anything
 * else is the same 404. Nothing here touches review state, the build verdict or the diff.
 */

type FlagInput = { kind: FlagKind; note: string | null; rect: IgnoreRect | null };

/** A flag as the snapshot page shows it; `mine` is the viewer's own, the one they can edit. */
export type SnapshotFlag = FlagInput & {
  id: string;
  by: string;
  mine: boolean;
  createdAt: Date;
  updatedAt: Date;
};

async function snapshotInProject(db: Db, projectId: string, snapshotId: string) {
  const [row] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, snapshotId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("snapshot");
}

/** Create the user's flag on the shot, or replace the one they have: one per user per snapshot. */
export async function flagSnapshot(
  db: Db,
  input: FlagInput & { userId: string; projectId: string; snapshotId: string },
): Promise<void> {
  await getProject(db, input.userId, input.projectId);
  await snapshotInProject(db, input.projectId, input.snapshotId);
  // An edited flag is new work: whatever was exported from the old one no longer stands for it.
  const fields = {
    kind: input.kind,
    note: input.note,
    rect: input.rect,
    updatedAt: new Date(),
    exportedAt: null,
  };
  await db
    .insert(detectionFlags)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      createdBy: input.userId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [detectionFlags.snapshotId, detectionFlags.createdBy],
      set: fields,
    });
}

/** Remove the user's own flag on the shot; withdrawing one that is not there is a no-op. */
export async function withdrawFlag(
  db: Db,
  input: { userId: string; projectId: string; snapshotId: string },
): Promise<void> {
  await getProject(db, input.userId, input.projectId);
  await snapshotInProject(db, input.projectId, input.snapshotId);
  await db
    .delete(detectionFlags)
    .where(
      and(
        eq(detectionFlags.snapshotId, input.snapshotId),
        eq(detectionFlags.createdBy, input.userId),
      ),
    );
}

/** Every reviewer's flag on one shot, oldest first, so a second reviewer sees the first's. */
export async function snapshotFlags(
  db: Db,
  input: { userId: string; projectId: string; snapshotId: string },
): Promise<SnapshotFlag[]> {
  await getProject(db, input.userId, input.projectId);
  const rows = await db
    .select({
      id: detectionFlags.id,
      kind: detectionFlags.kind,
      note: detectionFlags.note,
      rect: detectionFlags.rect,
      createdBy: detectionFlags.createdBy,
      by: users.login,
      createdAt: detectionFlags.createdAt,
      updatedAt: detectionFlags.updatedAt,
    })
    .from(detectionFlags)
    .innerJoin(users, eq(users.id, detectionFlags.createdBy))
    .where(
      and(
        eq(detectionFlags.projectId, input.projectId),
        eq(detectionFlags.snapshotId, input.snapshotId),
      ),
    )
    .orderBy(asc(detectionFlags.createdAt), asc(detectionFlags.id));
  return rows.map(({ createdBy, ...row }) => ({ ...row, mine: createdBy === input.userId }));
}

/**
 * A project's flags, newest first, with what a bench case needs: the shot, its build, the blob
 * keys of all three images, the rect, and what the diff measured. Those are the shot's as they
 * stand now: a re-diff rewrites the diff blob under the same key, so a copy taken at flag time
 * would pair old numbers with a new image. The project page lists these; the export is this.
 */
export async function listFlags(db: Db, userId: string, projectId: string) {
  await getProject(db, userId, projectId);
  return (await projectFlags(db, projectId)).flags;
}

/** Where a page of flags stopped: the last flag's position in newest-first order. */
type FlagCursor = { createdAt: Date; id: string };

/**
 * The project's flags, newest first, a page at a time when `page` is given (the API, ob 1729). The
 * caller has checked the project is reachable: here a project id is trusted.
 */
export async function projectFlags(
  db: Db,
  projectId: string,
  page?: { after?: FlagCursor | undefined; limit: number },
  flagId?: string,
) {
  const after = page?.after;
  const query = db
    .select({
      id: detectionFlags.id,
      kind: detectionFlags.kind,
      note: detectionFlags.note,
      rect: detectionFlags.rect,
      diffStatus: snapshots.diffStatus,
      diffResult: snapshots.diffResult,
      diffOptions: snapshots.diffOptions,
      snapshot: {
        id: snapshots.id,
        name: snapshots.name,
        platform: snapshots.platform,
        browser: snapshots.browser,
        viewport: snapshots.viewport,
        theme: snapshots.theme,
      },
      build: { id: builds.id, branch: builds.branch, commitSha: builds.commitSha },
      keys: {
        image: snapshots.imageKey,
        baseline: snapshots.baselineKey,
        diff: snapshots.diffKey,
      },
      by: users.login,
      createdAt: detectionFlags.createdAt,
      updatedAt: detectionFlags.updatedAt,
      exportedAt: detectionFlags.exportedAt,
    })
    .from(detectionFlags)
    .innerJoin(snapshots, eq(snapshots.id, detectionFlags.snapshotId))
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(users, eq(users.id, detectionFlags.createdBy))
    .where(
      and(
        eq(detectionFlags.projectId, projectId),
        flagId === undefined ? undefined : eq(detectionFlags.id, flagId),
        after &&
          or(
            lt(detectionFlags.createdAt, after.createdAt),
            and(eq(detectionFlags.createdAt, after.createdAt), lt(detectionFlags.id, after.id)),
          ),
      ),
    )
    .orderBy(desc(detectionFlags.createdAt), desc(detectionFlags.id));
  const rows = page ? await query.limit(page.limit + 1) : await query;
  const more = page !== undefined && rows.length > page.limit;
  const shown = page ? rows.slice(0, page.limit) : rows;
  const last = shown.at(-1);
  return {
    flags: shown.map(({ diffStatus, diffResult, diffOptions, ...row }) => ({
      ...row,
      measured: { diffStatus, changedPixels: diffResult?.changedPixels ?? null, diffOptions },
    })),
    next: more && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export type ProjectFlag = Awaited<ReturnType<typeof listFlags>>[number];

/** The project a flag belongs to; a missing flag is a 404. */
export async function flagProjectId(db: Db, flagId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: detectionFlags.projectId })
    .from(detectionFlags)
    .where(eq(detectionFlags.id, flagId));
  if (!row) throw new NotFoundError("detection flag");
  return row.projectId;
}

/**
 * Mark a flag as turned into a bench case (ob 1734) and return it. The caller has checked the
 * project is reachable. Marking it again keeps the first time.
 */
export async function markFlagExported(
  db: Db,
  projectId: string,
  flagId: string,
): Promise<ProjectFlag> {
  await db
    .update(detectionFlags)
    .set({ exportedAt: new Date() })
    .where(
      and(
        eq(detectionFlags.projectId, projectId),
        eq(detectionFlags.id, flagId),
        isNull(detectionFlags.exportedAt),
      ),
    );
  const [flag] = (await projectFlags(db, projectId, undefined, flagId)).flags;
  if (!flag) throw new NotFoundError("detection flag");
  return flag;
}
