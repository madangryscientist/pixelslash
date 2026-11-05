import { and, count, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { STALE_PROCESSING_MS } from "#/diff/claim";
import type { Db } from "./db";
import { builds, orgs, projects } from "./schema";
import { real } from "./synthetic";

/** The "now" group of the operator's health page (PS-330): what is in flight, and what is stuck. */

/** How many stuck builds are listed; the count above them is the whole. */
const STUCK_LISTED = 50;

type InFlight = {
  id: string;
  projectId: string;
  status: string;
  createdAt: Date;
  ageMs: number;
};

type StuckBuild = InFlight & { processingStartedAt: Date; stuckMs: number };

export const isReal = () => real(orgs.isSmoke);

export type NowHealth = {
  byStatus: Record<string, number>;
  inFlight: number;
  oldestInFlight: InFlight | null;
  stuckAfterMs: number;
  stuckTotal: number;
  stuck: StuckBuild[];
};

export async function nowSection(db: Db, now: Date): Promise<NowHealth> {
  const byStatus: Record<string, number> = {};
  const grouped = await db
    .select({ status: builds.status, n: count() })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(isReal())
    .groupBy(builds.status);
  for (const row of grouped) byStatus[row.status] = row.n;

  const flying = inArray(builds.status, ["uploading", "processing"]);
  const [oldest] = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      createdAt: builds.createdAt,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(and(isReal(), flying))
    .orderBy(builds.createdAt)
    .limit(1);

  const cutoff = new Date(now.getTime() - STALE_PROCESSING_MS);
  const stuckWhere = and(
    isReal(),
    eq(builds.status, "processing"),
    isNotNull(builds.processingStartedAt),
    lt(builds.processingStartedAt, cutoff),
  );
  const stuckRows = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      createdAt: builds.createdAt,
      processingStartedAt: builds.processingStartedAt,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(stuckWhere)
    .orderBy(builds.processingStartedAt)
    .limit(STUCK_LISTED);
  const [stuckCount] = await db
    .select({ n: count() })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(stuckWhere);

  const age = (from: Date) => Math.max(0, now.getTime() - from.getTime());
  const stuck: StuckBuild[] = [];
  for (const row of stuckRows) {
    if (!row.processingStartedAt) continue;
    stuck.push({
      ...row,
      processingStartedAt: row.processingStartedAt,
      ageMs: age(row.createdAt),
      stuckMs: age(row.processingStartedAt),
    });
  }
  return {
    byStatus,
    inFlight: (byStatus["uploading"] ?? 0) + (byStatus["processing"] ?? 0),
    oldestInFlight: oldest ? { ...oldest, ageMs: age(oldest.createdAt) } : null,
    stuckAfterMs: STALE_PROCESSING_MS,
    stuckTotal: stuckCount?.n ?? 0,
    stuck,
  };
}
