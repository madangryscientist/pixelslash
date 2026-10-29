import { type SQL, and, eq, inArray, lte, ne, or } from "drizzle-orm";
import type { Db } from "./db";
import type { Build } from "./builds";
import { inChunks } from "./chunks";
import { heldShot, notSkippedFlaky } from "./markers";
import { builds, type IgnoreRect, snapshots } from "./schema";

/**
 * Baseline selection (ob 1470, ob 1712), with no git access: the CLI uploads the merge-base and
 * the ancestor SHAs, and the server picks, per snapshot key:
 *
 * 1. The same branch's previous shot, reviewed or not: the newest earlier build of this branch
 *    that holds the key and was not rejected. A re-run of one commit is therefore 0 changed, and
 *    the shot carries forward after a rebase or an amend too.
 * 2. Else the shot in the accepted build at the nearest of the merge-base and its ancestors (the
 *    CLI sends up to 200, so a project that CI skipped for a long stretch of main still finds its
 *    last build; ob 1788). Within one commit, the newest build. Nothing newer than the merge-base
 *    is ever in the list, so nothing newer is picked.
 *
 * A previous shot whose change is still undecided is not an accepted image, so it is a baseline
 * only for an unchanged shot, which then carries the open change (`carried_from`). A shot that
 * differs from it is measured against rule 2's accepted shot instead, so accepting it never
 * approves a change nobody was shown. A build that was rejected never feeds a baseline. On the
 * project's default branch every shot is accepted, so rule 1 there is the rule it always had.
 *
 * Rule 1 compares with the previous shot only, so it cannot see a difference from main that the
 * previous build did not carry; `diff/open-vs-main.ts` carries that after the fact (PS-284). The
 * picks here are not changed by it.
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
  /** The image's sha256 and size from upload (ob 1948); null on a shot that predates them. */
  imageSha256: string | null;
  imageSize: { width: number; height: number } | null;
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
  /** The accepted shot at the nearest commit in reach; read only when `carry` is set. Missing is `new`. */
  accepted: BaselineSnapshot | undefined;
};

export type Baselines = {
  /** Snapshot key → what this build's shot is compared against. A missing key is `new`. */
  byKey: Map<string, Baseline>;
  /** Shots the baseline build had and this one does not: removed, and never blocking. */
  removed: BaselineSnapshot[];
  /**
   * Snapshot key → the shot the branch is measured against for its final review (ob 1723): the
   * accepted shot of another branch at the nearest commit in reach, so of main at the merge-base. Unlike `byKey`
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
  commitSha: string;
  createdAt: Date;
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

/**
 * A shot its own build measured, or one accepted as it is (PS-282): a row with no result that
 * nobody accepted (a branch shot from another environment, or a run that lost its write) was
 * compared with nothing, so it would hand the next build a baseline that hides what was open.
 * The default branch accepts its re-baseline shots, so a new environment still becomes the baseline.
 */
const measuredRow = (row: Candidate) => row.diffStatus !== null || row.reviewState === "accepted";

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
  imageSha256,
  imageSize,
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
  imageSha256,
  imageSize,
});

/** Statement parameters besides the commit list in `queryCandidates`' WHERE (see `inChunks`). */
const OTHER_PARAMS = 12;

/**
 * Every shot that may be a baseline: an accepted one (see `acceptedRow`; the default branch
 * auto-accepts, so a squash-merged build there counts), or any shot of this branch. Only from a
 * build that was not rejected, and never one with no result (see `measuredRow`). The commit list can outgrow D1's parameter cap, so it is read in
 * parts and merged; `order` then puts the rows in the order the picks walk them.
 */
async function queryCandidates(db: Db, build: PickFor): Promise<Candidate[]> {
  const commits = [build.mergeBaseSha, ...build.ancestorShas].filter(
    (sha): sha is string => sha !== null,
  );
  const read = (reach: SQL | undefined) =>
    db
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
        imageSha256: snapshots.imageSha256,
        imageSize: snapshots.imageSize,
        branch: builds.branch,
        commitSha: builds.commitSha,
        createdAt: builds.createdAt,
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
          // A build created after this one cannot be its baseline.
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
          // The reach filter belongs in SQL: the same 128 MB isolate that runs the diff has no
          // business reading every accepted snapshot the project has ever held.
          reach,
        ),
      );
  const own = await read(eq(builds.branch, build.branch));
  const others = await inChunks(commits, OTHER_PARAMS, (part) =>
    read(and(ne(builds.branch, build.branch), inArray(builds.commitSha, part))),
  );
  return order([...own, ...others].filter(measuredRow), build, commits);
}

/**
 * This branch's own shots first, then the rest by how near their commit is to the merge-base (the
 * list's order), and within one commit or one branch the newest build, then the newest shot. Both
 * picks and `primaryBuild` take the first row they meet, so this is the whole ranking.
 */
function order(rows: Candidate[], build: PickFor, commits: string[]): Candidate[] {
  const nearness = new Map(commits.map((sha, at) => [sha, at]));
  const near = (row: Candidate) =>
    row.branch === build.branch ? -1 : (nearness.get(row.commitSha) ?? commits.length);
  return rows.toSorted(
    (a, b) =>
      near(a) - near(b) ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.id.localeCompare(a.id),
  );
}

/** In `order`'s order: a same-branch shot outranks any other, then the nearest commit's. */
function pickAccepted(candidates: Candidate[]): Map<string, Candidate> {
  const picked = new Map<string, Candidate>();
  for (const row of candidates) {
    const key = snapshotKeyOf(row);
    if (acceptedRow(row) && !picked.has(key)) picked.set(key, row);
  }
  return picked;
}

/** In `order`'s order, from other branches only: what the branch changes against main (see `Baselines.main`). */
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
  const accepted = pickAccepted(candidates);
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

/** The build whose set of shots decides what was removed: the branch's previous one, else the accepted one at the nearest commit in reach. */
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
      imageSha256: snapshots.imageSha256,
      imageSize: snapshots.imageSize,
    })
    .from(snapshots)
    .where(and(eq(snapshots.buildId, baselineBuildId), heldShot()));
  return rows.filter((row) => !keys.has(snapshotKeyOf(row)));
}

/**
 * What one shot is compared against: the pick, unless that was rendered in another environment and
 * main's accepted shot was rendered in the shot's own (PS-282). A branch whose previous build came
 * from an old environment is then measured once main is captured in the new one, rather than
 * asking for a re-baseline, and having no verdict, on every build after. An undecided change in
 * the old environment cannot be carried by a shot from the new one, so main's shot is measured
 * against plainly: a change still there is shown again.
 */
export function baselineFor(
  baselines: Baselines,
  shot: SnapshotKey & { envFingerprint: string },
): Baseline | undefined {
  const key = snapshotKeyOf(shot);
  const picked = baselines.byKey.get(key);
  if (!picked || picked.shot.envFingerprint === shot.envFingerprint) return picked;
  const main = baselines.main.get(key);
  if (main?.envFingerprint !== shot.envFingerprint) return picked;
  return { shot: main, carry: null, accepted: main };
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
