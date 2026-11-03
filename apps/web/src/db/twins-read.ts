import { and, desc, eq, inArray, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { type Platform, type Twin, platformOfServer } from "#/lib/twins";
import { inChunks } from "./chunks";
import type { Db } from "./db";
import { heldShot, notSkippedFlaky } from "./markers";
import { builds, snapshots } from "./schema";

// The reads under the twin pairing (PS-295, `db/twins.ts`): which shots a build holds, which are
// the current baselines on a platform, and which build of a project sits at a commit.

/** Builds that hold diffed shots: the ones a twin may be read from. */
const DIFFED = ["changes", "passed", "failed"] as const;

export type Shot = Omit<Twin, "source">;

export type Held = Shot & { name: string; theme: string };

/** Statement parameters besides the names in the baselines read: projects, statuses, platforms, build. */
const OTHER_PARAMS = 10;

/** `platform` of the stored column, in SQL: android and ios are themselves, anything else is web. */
function onPlatforms(platforms: readonly Platform[]) {
  const natives = platforms.filter((p) => p !== "web");
  const native = natives.length > 0 ? inArray(snapshots.platform, natives) : undefined;
  const web = platforms.includes("web")
    ? notInArray(snapshots.platform, ["android", "ios"])
    : undefined;
  return or(native, web);
}

const columns = {
  id: snapshots.id,
  name: snapshots.name,
  theme: snapshots.theme,
  stored: snapshots.platform,
  browser: snapshots.browser,
  viewport: snapshots.viewport,
  metricsKey: snapshots.metricsKey,
  buildId: snapshots.buildId,
  projectId: builds.projectId,
  commitSha: builds.commitSha,
  createdAt: builds.createdAt,
};

export type Raw = {
  id: string;
  name: string;
  theme: string;
  stored: string;
  browser: string;
  viewport: string;
  metricsKey: string | null;
  buildId: string;
  projectId: string;
};

export function held(raw: Raw, projectName: (id: string) => string): Held {
  const platform = platformOfServer(raw.stored);
  return {
    snapshotId: raw.id,
    name: raw.name,
    theme: raw.theme,
    platform,
    device: platform === "web" ? null : raw.browser,
    viewport: raw.viewport,
    projectId: raw.projectId,
    projectName: projectName(raw.projectId),
    buildId: raw.buildId,
    hasMetrics: raw.metricsKey !== null,
  };
}

/** The shots one build holds (its removed markers are not shots). */
export async function shotsOf(db: Db, buildId: string): Promise<Raw[]> {
  return db
    .select(columns)
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.buildId, buildId), heldShot()));
}

/** What makes a shot a current baseline, as in `db/baselines.ts`: a removed marker or a skipped flaky shot never is. */
function baselineWhere(projectIds: string[], platforms: readonly Platform[], exceptBuild: string) {
  return and(
    inArray(builds.projectId, projectIds),
    ne(builds.id, exceptBuild),
    inArray(builds.status, ["changes", "passed"]),
    // Accepted: the build passed, or a reviewer accepted the shot; and measured, or accepted as it is.
    or(eq(builds.status, "passed"), eq(snapshots.reviewState, "accepted")),
    or(isNotNull(snapshots.diffStatus), eq(snapshots.reviewState, "accepted")),
    heldShot(),
    notSkippedFlaky(),
    onPlatforms(platforms),
  );
}

/**
 * The newest accepted shot per snapshot key, in the given projects, on the given platforms and
 * under the given names: what a project's baselines are right now.
 */
export async function baselinesOf(
  db: Db,
  input: { projectIds: string[]; platforms: Platform[]; names: string[]; exceptBuild: string },
): Promise<Raw[]> {
  if (input.platforms.length === 0) return [];
  const rows = await inChunks(input.names, OTHER_PARAMS + input.projectIds.length, (names) =>
    db
      .select(columns)
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .where(
        and(
          baselineWhere(input.projectIds, input.platforms, input.exceptBuild),
          inArray(snapshots.name, names),
        ),
      )
      .orderBy(desc(builds.createdAt), desc(snapshots.id)),
  );
  const newest = new Map<string, Raw>();
  for (const row of rows.toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )) {
    const key = JSON.stringify([
      row.projectId,
      row.name,
      platformOfServer(row.stored),
      row.browser,
      row.viewport,
      row.theme,
    ]);
    if (!newest.has(key)) newest.set(key, row);
  }
  return [...newest.values()];
}

/**
 * Whether the projects hold any current baseline on the platform, under any name. A platform that
 * has baselines is in play even when none shares a name with this build: its shots then have no twin.
 */
export async function hasBaselines(
  db: Db,
  input: { projectIds: string[]; platform: Platform; exceptBuild: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(baselineWhere(input.projectIds, [input.platform], input.exceptBuild))
    .limit(1);
  return row !== undefined;
}

/** The twin project's newest diffed build at `commitSha`, or null. */
export async function buildAtCommit(db: Db, projectId: string, commitSha: string) {
  const [row] = await db
    .select({ id: builds.id, commitSha: builds.commitSha })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        eq(builds.commitSha, commitSha),
        inArray(builds.status, [...DIFFED]),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(1);
  return row ?? null;
}
