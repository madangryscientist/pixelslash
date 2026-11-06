import { type SQL, and, eq, isNotNull, sql } from "drizzle-orm";
import { P99_MIN_BUILDS, P99_MIN_COMPARES, type StepStats, gatedStats } from "#/lib/timings";
import { atRank, ranCompare } from "./build-compares";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, orgs, projects, snapshots } from "./schema";

/**
 * The window-wide figures of the operator page (PS-342): how many snapshots a build holds and how
 * long a snapshot's compare takes, over every build that ended in the window rather than one build
 * at a time. Computed in SQL, nearest-rank as `percentile` in `lib/timings.ts` reads it, so no
 * snapshot row reaches JS. `inWindow` is the page's own filter (real orgs, `endedSince`).
 */

export type WindowFigures = {
  /** Held shots per build, cache hits included; builds that hold none are not counted. */
  perBuild: StepStats | null;
  /**
   * The server's compare time per shot, no cache hit in it. A CI build's times live in
   * `builds.timings`, one JSON value per build; reading them would read every build of the window.
   */
  perSnapshot: StepStats | null;
};

/** Snapshots per build: one grouped read over `snapshots_build_idx`, ranked over the builds. */
async function snapshotsPerBuild(db: Db, inWindow: SQL | undefined): Promise<StepStats | null> {
  const perBuild = db
    .select({ held: sql<number>`count(*)`.as("held") })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(and(inWindow, heldShot()))
    .groupBy(snapshots.buildId)
    .as("per_build");
  const ranked = db
    .select({
      ms: sql<number>`per_build.held`.as("ms"),
      rn: sql<number>`row_number() over (order by per_build.held)`.as("rn"),
      n: sql<number>`count(*) over ()`.as("n"),
    })
    .from(perBuild)
    .as("ranked");
  return rankedStats(db, ranked, P99_MIN_BUILDS);
}

/** Time per snapshot: every server compare of the window with a time, ranked in one pass. */
function timeSample(db: Db, inWindow: SQL | undefined) {
  return db
    .select({
      ms: sql<number>`snapshots.diff_ms`.as("ms"),
      rn: sql<number>`row_number() over (order by snapshots.diff_ms)`.as("rn"),
      n: sql<number>`count(*) over ()`.as("n"),
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(
      and(inWindow, eq(snapshots.measuredBy, "server"), isNotNull(snapshots.diffMs), ranCompare()),
    )
    .as("ranked");
}

/** A sample ranked ascending, with its size on every row: what `atRank` reads. */
type Ranked = ReturnType<typeof timeSample>;

async function rankedStats(db: Db, ranked: Ranked, p99Min: number): Promise<StepStats | null> {
  const [row] = await db
    .select({
      p50: atRank(50),
      p95: atRank(95),
      p99: atRank(99),
      max: sql<number>`max(ms)`,
      n: sql<number>`count(*)`,
    })
    .from(ranked);
  return row && row.n > 0 ? gatedStats(row, p99Min) : null;
}

export async function windowFigures(db: Db, inWindow: SQL | undefined): Promise<WindowFigures> {
  return {
    perBuild: await snapshotsPerBuild(db, inWindow),
    perSnapshot: await rankedStats(db, timeSample(db, inWindow), P99_MIN_COMPARES),
  };
}
