import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "#/db/db";
import type { Build } from "#/db/builds";
import { builds } from "#/db/schema";

/**
 * How long a `processing` build is presumed alive. A run killed mid-diff (the isolate hits its
 * 30 s CPU limit on a build of several whole-page changes, or the Worker is evicted) never gets
 * to write `errored`, so its build would read `processing` for ever. Nothing heartbeats, so age
 * is the only evidence of death: a build claimed longer ago than this has no live run, and the
 * next finalise may take it over. It must outlast any run that is still going — the request is
 * capped at 30 s of CPU, and R2 waits add wall time, not CPU — and stay short enough that a
 * client retrying finalise is not left waiting on a corpse. Five minutes is ten times the cap.
 *
 * The claim is a lease without a fence: a run still alive past the bound would be overwritten by
 * its successor's verdict. That is a choice; fencing every write is more than this needs.
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/**
 * A CI project's build is measured once, by the finalise that closes it (ob 1727): the results are
 * the CI job's, and a server run again would check the same results, or diff the shots itself. So
 * an errored one is not run again (ob 1545's recovery); the CI job is.
 */
export class NoRecoveryError extends Error {
  constructor() {
    super(
      "this project diffs in CI: a build that errored is not measured again; re-run the CI job",
    );
    this.name = "NoRecoveryError";
  }
}

/**
 * Take the build for one diff run, or learn that someone else holds it. One conditional UPDATE,
 * so of two concurrent calls only one wins. A build is claimable when it errored, when it was
 * finalised and no run has started (null), or when its run began more than the bound ago. A CI
 * project's build is claimable only by its first run. `startedAt` is the run's start, which its
 * timings (ob 1792) are counted from.
 */
export async function claim(
  db: Db,
  build: Build,
  { ci, startedAt }: { ci: boolean; startedAt: Date },
): Promise<boolean> {
  if (ci) {
    const first = await db
      .update(builds)
      .set({ processingStartedAt: startedAt })
      .where(
        and(
          eq(builds.id, build.id),
          eq(builds.status, "processing"),
          isNull(builds.processingStartedAt),
        ),
      )
      .returning({ id: builds.id });
    return first.length > 0;
  }
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await db
    .update(builds)
    .set({ status: "processing", error: null, processingStartedAt: startedAt })
    .where(
      and(
        eq(builds.id, build.id),
        or(
          eq(builds.status, "errored"),
          and(
            eq(builds.status, "processing"),
            or(isNull(builds.processingStartedAt), lt(builds.processingStartedAt, cutoff)),
          ),
        ),
      ),
    )
    .returning({ id: builds.id });
  return claimed.length > 0;
}

/** A `processing` build whose run began longer ago than the bound: no run is alive on it. */
export const dead = (build: Build) =>
  build.status === "processing" &&
  build.processingStartedAt !== null &&
  build.processingStartedAt.getTime() < Date.now() - STALE_PROCESSING_MS;

/**
 * Take a build with a verdict (`changes`, `passed`, `failed`) to re-diff a shot a reviewer picked
 * (ob 1738). One conditional UPDATE, like `claim`, so a re-run never races another run.
 */
export async function claimForRerun(db: Db, build: Build, startedAt: Date): Promise<boolean> {
  const claimed = await db
    .update(builds)
    .set({ status: "processing", error: null, processingStartedAt: startedAt })
    .where(and(eq(builds.id, build.id), inArray(builds.status, ["changes", "passed", "failed"])))
    .returning({ id: builds.id });
  return claimed.length > 0;
}
