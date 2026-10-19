import { count, eq } from "drizzle-orm";
import type { Db } from "./db";
import { builds, orgs, projects, snapshots } from "./schema";
import { real } from "./synthetic";

/** The usage numbers a bill or a dashboard reads. Smoke orgs never count. */
export async function usageCounts(db: Db): Promise<{ builds: number; snapshots: number }> {
  const [b] = await db
    .select({ n: count() })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(real(orgs.isSmoke));
  const [s] = await db
    .select({ n: count() })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(real(orgs.isSmoke));
  return { builds: b?.n ?? 0, snapshots: s?.n ?? 0 };
}
