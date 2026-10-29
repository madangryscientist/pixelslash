import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Db } from "./db";
import { type BuildCounts, countBuilds, emptyCounts } from "./build-counts";
import { type BuildStatus, builds } from "./schema";

/** A project's builds as lists: the project page's whole list, and the API's pages (ob 1729). */

export type BuildSummary = {
  id: string;
  branch: string;
  commitSha: string;
  prNumber: number | null;
  status: (typeof builds.$inferSelect)["status"];
  error: string | null;
  createdAt: Date;
  counts: BuildCounts;
};

const summaryColumns = {
  id: builds.id,
  branch: builds.branch,
  commitSha: builds.commitSha,
  prNumber: builds.prNumber,
  status: builds.status,
  error: builds.error,
  createdAt: builds.createdAt,
};

async function withCounts(db: Db, rows: Omit<BuildSummary, "counts">[]): Promise<BuildSummary[]> {
  if (rows.length === 0) return [];
  const counts = await countBuilds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, counts: counts.get(row.id) ?? emptyCounts() }));
}

/** Every build of a project, newest first, with the counts the project page prints. */
export async function listBuilds(db: Db, projectId: string): Promise<BuildSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(builds)
    .where(eq(builds.projectId, projectId))
    .orderBy(desc(builds.createdAt), desc(builds.id));
  return withCounts(db, rows);
}

/** Where a page of builds stopped: the last build's position in newest-first order. */
type BuildCursor = { createdAt: Date; id: string };

/**
 * One page of a project's builds, newest first, optionally on one branch or in one status: the
 * API's list (ob 1729). `next` is the cursor of the last build when more may follow.
 */
export async function pageBuilds(
  db: Db,
  projectId: string,
  page: {
    branch?: string | undefined;
    status?: BuildStatus | undefined;
    after?: BuildCursor | undefined;
    limit: number;
  },
): Promise<{ builds: BuildSummary[]; next: BuildCursor | null }> {
  const { after } = page;
  const rows = await db
    .select(summaryColumns)
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        page.branch === undefined ? undefined : eq(builds.branch, page.branch),
        page.status === undefined ? undefined : eq(builds.status, page.status),
        after &&
          or(
            lt(builds.createdAt, after.createdAt),
            and(eq(builds.createdAt, after.createdAt), lt(builds.id, after.id)),
          ),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(page.limit + 1);
  const more = rows.length > page.limit;
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    builds: await withCounts(db, shown),
    next: more && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
