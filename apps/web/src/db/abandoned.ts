import { and, asc, eq, gte, inArray, isNull, lt, notExists, or } from "drizzle-orm";
import type { Db } from "./db";
import { builds, snapshots } from "./schema";

/**
 * Abandoned builds (PS-324): a build whose uploader went away reads `uploading` or `processing`
 * for ever. `claim.ts` takes a dead diff run over only when a client sends finalise again, and
 * nothing does once the uploader is gone, so such a build is counted in flight on `/_admin` until
 * it is ended here, at `errored`, with a reason that names the limit.
 *
 * Six hours is six times the longest build measured so far (just under an hour); sweeps run
 * hourly, so a build is ended at most seven hours after its last sign of life.
 */
export const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

/** What an ended build's `error` says. */
export const ABANDONED_REASON =
  "no activity for 6 hours: the uploader or its run went away; send the build again";

type AbandonedOptions = {
  now: Date;
  /** At most this many builds, oldest first; the rest wait for the next sweep. */
  limit: number;
  /** Only this project's builds; unset sweeps every project's. */
  projectId?: string;
};

/**
 * End the builds that have shown no activity for `ABANDONED_AFTER_MS`, and return their ids,
 * oldest first. Last activity is the latest of a build's `createdAt`, its `processingStartedAt`
 * and the newest `createdAt` of its shots.
 *
 * It writes `status` and `error` and nothing else: no `finishedAt` and no timing column, because
 * no time was measured, and no row or blob is deleted. Each update holds the status it read, so a
 * build that finalised meanwhile stays as it is. Finalise sent again resumes an ended
 * server-diff build, as it does any `errored` one (ob 1545); a `ci` project's gets the 409 of
 * `NoRecoveryError`, and a build that never finalised is completed only by sending it again.
 */
export async function sweepAbandoned(
  db: Db,
  { now, limit, projectId }: AbandonedOptions,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const idle = await db
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(
      and(
        inArray(builds.status, ["uploading", "processing"]),
        lt(builds.createdAt, cutoff),
        or(isNull(builds.processingStartedAt), lt(builds.processingStartedAt, cutoff)),
        notExists(
          db
            .select({ one: snapshots.id })
            .from(snapshots)
            .where(and(eq(snapshots.buildId, builds.id), gte(snapshots.createdAt, cutoff))),
        ),
        projectId === undefined ? undefined : eq(builds.projectId, projectId),
      ),
    )
    .orderBy(asc(builds.createdAt), asc(builds.id))
    .limit(limit);
  const ended: string[] = [];
  for (const { id, status } of idle) {
    const won = await db
      .update(builds)
      .set({ status: "errored", error: ABANDONED_REASON })
      .where(and(eq(builds.id, id), eq(builds.status, status)))
      .returning({ id: builds.id });
    if (won.length > 0) ended.push(id);
  }
  return ended;
}
