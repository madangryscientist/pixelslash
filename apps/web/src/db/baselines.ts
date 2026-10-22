import { and, desc, eq, inArray, lte, ne, or } from "drizzle-orm";
import type { Db } from "./db";
import type { Build } from "./builds";
import { heldShot, notSkippedFlaky } from "./markers";
import { builds, type IgnoreRect, snapshots } from "./schema";

/**
 * Baseline selection (ob 1470, ob 1712), with no git access: the CLI uploads the merge-base and
 * the ancestor SHAs, and the server picks, per snapshot key:
 *
 * 1. The same branch's previous shot, reviewed or not: the newest earlier build of this branch
 *    that holds the key and was not rejected. A re-run of one commit is therefore 0 changed, and
 *    the shot carries forward after a rebase or an amend too.
 * 2. Else the shot in the newest accepted build among the merge-base and its ancestors.
 *
 * A previous shot whose change is still undecided is not an accepted image, so it is a baseline
 * only for an unchanged shot, which then carries the open change (`carried_from`). A shot that
 * differs from it is measured against rule 2's accepted shot instead, so accepting it never
 * approves a change nobody was shown. A build that was rejected never feeds a baseline. On the
 * project's default branch every shot is accepted, so rule 1 there is the rule it always had.
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

export type Baseline = {
  /** The shot this one is compared against first. */
  shot: BaselineSnapshot;
  /**
   * Set when `shot` holds an undecided change: the id of the shot that holds it. An identical
   * shot carries it; a different one is compared against `accepted` instead.
   */
  carry: string | null;
  /** The newest accepted shot in reach; read only when `carry` is set. Missing is `new`. */
  accepted: BaselineSnapshot | undefined;
};

export type Baselines = {
  /** Snapshot key → what this build's shot is compared against. A missing key is `new`. */
  byKey: Map<string, Baseline>;
  /** Shots the baseline build had and this one does not: removed, and never blocking. */
  removed: BaselineSnapshot[];
  /**
   * Snapshot key → the shot the branch is measured against for its final review (ob 1723): the
   * newest accepted shot of another branch in reach, so of main at the merge-base. Unlike `byKey`
   * it never takes this branch's own shots, accepted or not. A missing key is `new` against main.
   */
  main: Map<string, BaselineSnapshot>;
};

/** What the pick reads of the build it picks for; the read-only baselines endpoint makes one up. */
export type PickFor = Pick<
  Build,
  "id" | "projectId" | "createdAt" | "branch" | "mergeBaseSha" | "ancestorShas"
>;

const emptyBaselines = (): Baselines => ({ byKey: new Map(), removed: [], main: new Map() });

type Candidate = BaselineSnapshot & {
  branch: string;
  buildId: string;
  buildStatus: string;
  diffStatus: string | null;
  reviewState: string;
  carriedFrom: string | null;
};

/** Accepted for a baseline from any build: the build passed, or this one shot was accepted. */
const acceptedRow = (row: Candidate) =>
  row.buildStatus === "passed" || row.reviewState === "accepted";

/** A shot whose change nobody has decided yet: a baseline only for an identical shot. */
const openRow = (row: Candidate) =>
  row.reviewState === "pending" && (row.diffStatus === "changed" || row.carriedFrom !== null);

const baselineOf = ({
  id,
  name,
  platform,
  browser,
  viewport,
  theme,
  ignore,
  envFingerprint,
  imageKey,
}: Candidate): BaselineSnapshot => ({
  id,
  name,
  platform,
  browser,
  viewport,
  theme,
  ignore,
  envFingerprint,
  imageKey,
});

/**
 * Every shot that may be a baseline, newest first: an accepted one (see `acceptedRow`; the default
 * branch auto-accepts, so a squash-merged build there counts), or any shot of this branch. Only from a
 * build that was not rejected.
 */
function queryCandidates(db: Db, build: PickFor) {
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
      buildStatus: builds.status,
      diffStatus: snapshots.diffStatus,
      reviewState: snapshots.reviewState,
      carriedFrom: snapshots.carriedFrom,
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
        or(
          eq(builds.status, "passed"),
          eq(snapshots.reviewState, "accepted"),
          eq(builds.branch, build.branch),
        ),
        // A removed row is a marker, not an image of that build: it can never be a baseline.
        heldShot(),
        // A flaky shot its config skips is never a baseline unless a reviewer accepted it (ob 1724).
        notSkippedFlaky(),
        inReach,
      ),
    )
    .orderBy(desc(builds.createdAt), desc(snapshots.id));
}

/** Newest first; a same-branch shot outranks a newer one from another branch. */
function pickAccepted(candidates: Candidate[], build: PickFor): Map<string, Candidate> {
  const picked = new Map<string, Candidate>();
  for (const row of candidates) {
    if (!acceptedRow(row)) continue;
    const key = snapshotKeyOf(row);
    const held = picked.get(key);
    const preferred = row.branch === build.branch && held?.branch !== build.branch;
    if (!held || preferred) picked.set(key, row);
  }
  return picked;
}

/** Newest first, from other branches only: what the branch changes against main (see `Baselines.main`). */
function pickMain(candidates: Candidate[], build: PickFor): Map<string, BaselineSnapshot> {
  const picked = new Map<string, BaselineSnapshot>();
  for (const row of candidates) {
    const key = snapshotKeyOf(row);
    if (row.branch !== build.branch && acceptedRow(row) && !picked.has(key))
      picked.set(key, baselineOf(row));
  }
  return picked;
}

function pick(candidates: Candidate[], build: PickFor): Map<string, Baseline> {
  const accepted = pickAccepted(candidates, build);
  const previous = new Map<string, Candidate>();
  for (const row of candidates) {
    const key = snapshotKeyOf(row);
    if (row.branch === build.branch && !previous.has(key)) previous.set(key, row);
  }
  const picked = new Map<string, Baseline>();
  for (const key of new Set([...accepted.keys(), ...previous.keys()])) {
    const prior = previous.get(key);
    const held = accepted.get(key);
    const fallback = held && baselineOf(held);
    if (prior) {
      const carry = openRow(prior) ? (prior.carriedFrom ?? prior.id) : null;
      picked.set(key, { shot: baselineOf(prior), carry, accepted: fallback });
    } else if (fallback) picked.set(key, { shot: fallback, carry: null, accepted: fallback });
  }
  return picked;
}

/** The build whose set of shots decides what was removed: the branch's previous one, else the newest accepted one in reach. */
function primaryBuild(build: PickFor, candidates: Candidate[]): string | null {
  const onBranch = candidates.find((row) => row.branch === build.branch);
  return (onBranch ?? candidates.find(acceptedRow))?.buildId ?? null;
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
    .where(and(eq(snapshots.buildId, baselineBuildId), heldShot()));
  return rows.filter((row) => !keys.has(snapshotKeyOf(row)));
}

export async function selectBaselines(
  db: Db,
  build: PickFor,
  keys: Set<string>,
): Promise<Baselines> {
  const candidates = await queryCandidates(db, build);
  if (candidates.length === 0) return emptyBaselines();
  const baselineBuildId = primaryBuild(build, candidates);
  return {
    byKey: pick(candidates, build),
    removed: await removedSince(db, baselineBuildId, keys),
    main: pickMain(candidates, build),
  };
}
