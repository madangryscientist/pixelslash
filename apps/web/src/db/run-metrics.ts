import { and, desc, eq, inArray } from "drizzle-orm";
import { type BranchBuildRow, BRANCH_WINDOW } from "#/lib/branch-metrics";
import { compareMsOf, compared } from "#/lib/run-metrics";
import type { Db } from "./db";
import { builds, flakes, snapshots } from "./schema";

/**
 * What the build and branch pages' metrics read beyond the build view (PS-233). Read only: every
 * figure is one the server or the CLI already stored.
 */

/**
 * The re-captures the CLI sent for this build's shots found flaky: each flake's runs past the
 * first. Null when the build stored no flake evidence; a shot whose re-captures agreed stores none.
 */
export async function flakeRecaptures(
  db: Db,
  buildId: string,
  shots: readonly { flakeId: string | null }[],
): Promise<number | null> {
  const flakeIds = shots.flatMap((shot) => (shot.flakeId ? [shot.flakeId] : []));
  if (flakeIds.length === 0) return null;
  const rows = await db
    .select({ evidence: flakes.evidence })
    .from(flakes)
    .where(inArray(flakes.id, [...new Set(flakeIds)]));
  const own = rows.flatMap((r) => r.evidence).filter((e) => e.buildId === buildId);
  return own.length === 0 ? null : own.reduce((n, e) => n + Math.max(0, e.runs - 1), 0);
}

/** The branch's newest builds (up to `BRANCH_WINDOW`), each with its compares and their times. */
export async function branchWindow(
  db: Db,
  projectId: string,
  branch: string,
): Promise<BranchBuildRow[]> {
  const recent = await db
    .select({ id: builds.id, createdAt: builds.createdAt, finishedAt: builds.finishedAt })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.branch, branch)))
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(BRANCH_WINDOW);
  if (recent.length === 0) return [];
  const shots = await db
    .select({
      buildId: snapshots.buildId,
      diffStatus: snapshots.diffStatus,
      rebaselineNeeded: snapshots.rebaselineNeeded,
      measuredBy: snapshots.measuredBy,
      diffMs: snapshots.diffMs,
    })
    .from(snapshots)
    .where(
      inArray(
        snapshots.buildId,
        recent.map((b) => b.id),
      ),
    );
  return recent.map((build) => {
    const measured = shots.filter((s) => s.buildId === build.id && compared(s));
    return {
      ...build,
      compares: measured.length,
      compareMs: measured.flatMap((s) => {
        const ms = compareMsOf(s);
        return ms === null ? [] : [ms];
      }),
    };
  });
}
