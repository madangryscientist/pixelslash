import { and, desc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "./db";
import type { Build } from "./builds";
import { builds, type IgnoreRect, snapshots } from "./schema";

/**
 * Baseline selection (ob 1470), Argos-style and with no git access: the CLI uploads the
 * merge-base and the ancestor SHAs, and the server picks. For each snapshot key the baseline is
 * the shot in the newest accepted build among the build's merge-base and ancestors; an accepted
 * shot on the same branch carries forward to a later build even when its commit is no longer an
 * ancestor (a rebase or an amend). A build that was rejected never feeds a baseline.
 */

/** The fields of a snapshot this module reads; a whole row would drag the blobs' JSON along. */
export type BaselineSnapshot = {
  id: string;
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
  ignore: IgnoreRect[];
  envFingerprint: string;
  imageKey: string;
};

/** The identity a snapshot is diffed under: name + the fixed variant. */
export type SnapshotKey = Pick<
  BaselineSnapshot,
  "name" | "platform" | "browser" | "viewport" | "theme"
>;

export function snapshotKeyOf(shot: SnapshotKey): string {
  return JSON.stringify([shot.name, shot.platform, shot.browser, shot.viewport, shot.theme]);
}

export type Baselines = {
  /** Snapshot key → the shot this build is compared against. A missing key is `new`. */
  byKey: Map<string, BaselineSnapshot>;
  /** Shots the baseline build had and this one does not: removed, and never blocking. */
  removed: BaselineSnapshot[];
};

const emptyBaselines = (): Baselines => ({ byKey: new Map(), removed: [] });

type Candidate = BaselineSnapshot & { branch: string; buildId: string };

/**
 * Accepted for a baseline: the build itself passed (main auto-accepts, so a squash-merged main
 * build counts), or this one shot was accepted on a build that was not rejected.
 */
function queryCandidates(db: Db, build: Build) {
  const commits = [build.mergeBaseSha, ...build.ancestorShas].filter(
    (sha): sha is string => sha !== null,
  );
  // The reach filter belongs in SQL: the same 128 MB isolate that runs the diff has no business
  // reading every accepted snapshot the project has ever held.
  const inReach = commits.length
    ? or(eq(builds.branch, build.branch), inArray(builds.commitSha, commits))
    : eq(builds.branch, build.branch);
  return db
    .select({
      id: snapshots.id,
      buildId: snapshots.buildId,
      name: snapshots.name,
      platform: snapshots.platform,
      browser: snapshots.browser,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      ignore: snapshots.ignore,
      envFingerprint: snapshots.envFingerprint,
      imageKey: snapshots.imageKey,
      branch: builds.branch,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(
      and(
        eq(builds.projectId, build.projectId),
        ne(builds.id, build.id),
        // A build created after this one cannot be its baseline. Two builds created in the same
        // millisecond are indistinguishable by clock, so the id tiebreak below keeps that pick
        // stable rather than dependent on the scan order.
        lte(builds.createdAt, build.createdAt),
        inArray(builds.status, ["changes", "passed"]),
        or(eq(builds.status, "passed"), eq(snapshots.reviewState, "accepted")),
        // A removed row is a marker, not an image of that build: it can never be a baseline.
        or(isNull(snapshots.diffStatus), ne(snapshots.diffStatus, "removed")),
        inReach,
      ),
    )
    .orderBy(desc(builds.createdAt), desc(snapshots.id));
}

/** Newest first; a same-branch shot outranks a newer one from another branch. */
function pick(candidates: Candidate[], build: Build): Map<string, Candidate> {
  const picked = new Map<string, Candidate>();
  for (const row of candidates) {
    const key = snapshotKeyOf(row);
    const held = picked.get(key);
    const preferred = row.branch === build.branch && held?.branch !== build.branch;
    if (!held || preferred) picked.set(key, row);
  }
  return picked;
}

/** The build whose set of shots decides what was removed: the newest accepted one in reach. */
function primaryBuild(build: Build, candidates: Candidate[]): string | null {
  const onBranch = candidates.find((row) => row.branch === build.branch);
  return (onBranch ?? candidates[0])?.buildId ?? null;
}

async function removedSince(
  db: Db,
  baselineBuildId: string | null,
  keys: Set<string>,
): Promise<BaselineSnapshot[]> {
  if (!baselineBuildId) return [];
  const rows = await db
    .select({
      id: snapshots.id,
      name: snapshots.name,
      platform: snapshots.platform,
      browser: snapshots.browser,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      ignore: snapshots.ignore,
      envFingerprint: snapshots.envFingerprint,
      imageKey: snapshots.imageKey,
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.buildId, baselineBuildId),
        // A re-baseline row has no status yet but is still a shot the build holds.
        or(isNull(snapshots.diffStatus), ne(snapshots.diffStatus, "removed")),
      ),
    );
  return rows.filter((row) => !keys.has(snapshotKeyOf(row)));
}

export async function selectBaselines(db: Db, build: Build, keys: Set<string>): Promise<Baselines> {
  const candidates = await queryCandidates(db, build);
  if (candidates.length === 0) return emptyBaselines();
  const picked = pick(candidates, build);
  const baselineBuildId = primaryBuild(build, candidates);
  return {
    byKey: new Map([...picked].map(([key, row]) => [key, row])),
    removed: await removedSince(db, baselineBuildId, keys),
  };
}
