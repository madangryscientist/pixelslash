import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "./db";
import { type Step, type StepStats, summarise } from "#/lib/timings";
import { requireMember } from "./orgs";
import { builds, orgs, projects } from "./schema";
import { real } from "./synthetic";

/**
 * How long a build's server steps take, per project, for the org's Timings page (ob 1792). The
 * numbers are the ones `server-timings.ts` writes on each build; this only reads and summarises.
 */

/** The page looks at builds that finished a server step in this long. */
export const TIMINGS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The newest builds of the window an org's page reads; an org with more is summarised on these. */
export const TIMINGS_MAX_BUILDS = 5000;

export type ProjectTimings = {
  projectId: string;
  name: string;
  /**
   * Builds of the window that finished a server step in one run, the ones the stats are over. A
   * build that took a second run (a resume after the budget, a shot re-diffed) holds the numbers of
   * its last run only, so it is left out rather than pooled as a whole build.
   */
  builds: number;
  steps: Record<Step, StepStats | null>;
};

/**
 * Every project of the org, with the stats of its builds that finished in the last 30 days (a
 * project without one is listed with none). Members only; a smoke org has no real timings.
 */
export async function orgTimings(
  db: Db,
  userId: string,
  orgId: string,
  now: Date,
): Promise<ProjectTimings[]> {
  await requireMember(db, userId, orgId);
  const listed = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(and(eq(projects.orgId, orgId), real(orgs.isSmoke)))
    .orderBy(projects.name);
  const since = new Date(now.getTime() - TIMINGS_WINDOW_MS);
  const rows = await db
    .select({
      projectId: builds.projectId,
      queueMs: builds.queueMs,
      diffMs: builds.diffMs,
      explainMs: builds.explainMs,
      summaryMs: builds.summaryMs,
      finishedAt: builds.finishedAt,
      processingStartedAt: builds.processingStartedAt,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(
      and(
        eq(projects.orgId, orgId),
        real(orgs.isSmoke),
        isNotNull(builds.finishedAt),
        eq(builds.rerun, false),
        gte(builds.finishedAt, since),
      ),
    )
    .orderBy(desc(builds.finishedAt))
    .limit(TIMINGS_MAX_BUILDS);
  const byProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const own = byProject.get(row.projectId);
    if (own) own.push(row);
    else byProject.set(row.projectId, [row]);
  }
  return listed.map(({ id, name }) => {
    const own = byProject.get(id) ?? [];
    return { projectId: id, name, builds: own.length, steps: summarise(own) };
  });
}
