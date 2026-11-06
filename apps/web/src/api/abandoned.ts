import { alias } from "drizzle-orm/sqlite-core";
import { and, eq, inArray, lt, notExists } from "drizzle-orm";
import { sweepAbandoned } from "#/db/abandoned";
import type { Db } from "#/db/db";
import { builds } from "#/db/schema";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import { warn } from "#/lib/log";

/** Builds one create-build request ends; the hourly sweep takes the rest. */
const SWEEP_ON_CREATE = 20;

/**
 * Sync the check runs of ended builds, but only a commit's newest build: an older build of the
 * same commit would otherwise put a stale red over the newer build's status (token mode keeps
 * the newest commit status written).
 */
export async function syncEnded(deps: CheckRunDeps, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const newer = alias(builds, "newer");
  const latest = await deps.db
    .select({ id: builds.id })
    .from(builds)
    .where(
      and(
        inArray(builds.id, ids),
        notExists(
          deps.db
            .select({ one: newer.id })
            .from(newer)
            .where(
              and(
                eq(newer.projectId, builds.projectId),
                eq(newer.commitSha, builds.commitSha),
                lt(builds.createdAt, newer.createdAt),
              ),
            ),
        ),
      ),
    );
  if (latest.length > 0)
    await syncCheckRuns(
      deps,
      latest.map((b) => b.id),
    );
}

/**
 * End this project's abandoned builds (PS-324). A self-host fires no cron, so a project is swept
 * when it next creates a build. It never fails the upload: a throw is logged and the build stands.
 */
export async function endAbandoned(
  ctx: { db: Db; checkRuns?: Omit<CheckRunDeps, "db"> | undefined },
  projectId: string,
): Promise<void> {
  try {
    const ended = await sweepAbandoned(ctx.db, {
      now: new Date(),
      limit: SWEEP_ON_CREATE,
      projectId,
    });
    if (ctx.checkRuns) await syncEnded({ db: ctx.db, ...ctx.checkRuns }, ended);
  } catch (error) {
    warn(`abandoned-build sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
