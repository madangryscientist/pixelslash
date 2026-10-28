import { and, asc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { SweepBlobStore } from "#/storage/blobs";
import { DAY_MS } from "#/lib/retention";
import { chunk, inChunks } from "./chunks";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, flakes, projects, snapshots } from "./schema";

/**
 * Retention (PS-239): a build older than the window, on a branch that is not its project's
 * default, is deleted with its blobs and rows, unless a build that stays still points at it.
 *
 * What a build that stays can point at, and so what keeps another build alive:
 * - `baseline_key` and `main_baseline_key`: the image it was compared against, and what a removed
 *   marker shows (a marker's `image_key` is the baseline build's blob too).
 * - `baseline_snapshot_id` and `carried_from`: the shot it was compared against, and the shot whose
 *   undecided change it carries.
 * A build kept for that reason keeps what it points at in turn, so the references are followed to a
 * fixpoint. Default-branch builds are never candidates, so they always stay and always count.
 *
 * Flake evidence names builds too, but an open flake would pin a build forever: the evidence of a
 * deleted build is dropped from its flake instead.
 *
 * What it does not keep: a shot that only an expired build of the same branch held. A later build
 * of that branch then falls back to the accepted shot at its merge-base, the way a first build does.
 */

export type RetentionOptions = {
  days: number;
  now: Date;
  /** At most this many builds, oldest first; the rest wait for the next sweep. */
  limit?: number;
};

export type PlannedBuild = {
  id: string;
  projectId: string;
  orgId: string;
  branch: string;
  createdAt: Date;
  /** Every blob under `builds/<id>/` in the org's store, with its size. */
  blobs: { key: string; size: number }[];
};

export type RetentionPlan = {
  days: number;
  cutoff: Date;
  /** Builds past the window that nothing needs. */
  expired: PlannedBuild[];
  /** Builds past the window that stay, because a build that stays points at them. */
  keptReferenced: string[];
};

export type RetentionResult = { buildsDeleted: number; blobsDeleted: number; bytesFreed: number };

type Candidate = Omit<PlannedBuild, "blobs">;

async function candidatesOf(db: Db, { days, now }: RetentionOptions): Promise<Candidate[]> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      orgId: projects.orgId,
      branch: builds.branch,
      createdAt: builds.createdAt,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(and(lt(builds.createdAt, cutoff), ne(builds.branch, projects.defaultBranch)))
    .orderBy(asc(builds.createdAt), asc(builds.id));
}

/**
 * Who points at whom: `referencer build → builds it points at`, among `candidates`. A referencer
 * outside them is a build that stays for certain.
 */
async function referencesAmong(db: Db, candidates: Candidate[]): Promise<Map<string, Set<string>>> {
  const ids = candidates.map((c) => c.id);
  const own = await inChunks(ids, 0, (part) =>
    db
      .select({ id: snapshots.id, buildId: snapshots.buildId, imageKey: snapshots.imageKey })
      .from(snapshots)
      .where(and(inArray(snapshots.buildId, part), heldShot())),
  );
  const ownerOfKey = new Map(own.map((s) => [s.imageKey, s.buildId]));
  const ownerOfShot = new Map(own.map((s) => [s.id, s.buildId]));

  const edges = new Map<string, Set<string>>();
  const point = (from: string, to: string | undefined) => {
    if (to === undefined || to === from) return;
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };
  // Two columns are matched per statement, so each key binds twice.
  for (const keys of chunk([...ownerOfKey.keys()], 0, 2)) {
    const rows = await db
      .select({
        buildId: snapshots.buildId,
        baselineKey: snapshots.baselineKey,
        mainBaselineKey: snapshots.mainBaselineKey,
      })
      .from(snapshots)
      .where(or(inArray(snapshots.baselineKey, keys), inArray(snapshots.mainBaselineKey, keys)));
    for (const row of rows) {
      point(row.buildId, ownerOfKey.get(row.baselineKey ?? ""));
      point(row.buildId, ownerOfKey.get(row.mainBaselineKey ?? ""));
    }
  }
  for (const shots of chunk([...ownerOfShot.keys()], 0, 2)) {
    const rows = await db
      .select({
        buildId: snapshots.buildId,
        baselineSnapshotId: snapshots.baselineSnapshotId,
        carriedFrom: snapshots.carriedFrom,
      })
      .from(snapshots)
      .where(
        or(inArray(snapshots.baselineSnapshotId, shots), inArray(snapshots.carriedFrom, shots)),
      );
    for (const row of rows) {
      point(row.buildId, ownerOfShot.get(row.baselineSnapshotId ?? ""));
      point(row.buildId, ownerOfShot.get(row.carriedFrom ?? ""));
    }
  }
  return edges;
}

/** The candidates something that stays points at, directly or through another one that stays. */
export function referencedBuilds(
  candidateIds: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const kept = new Set<string>();
  const queue: string[] = [];
  const keep = (id: string) => {
    if (kept.has(id)) return;
    kept.add(id);
    queue.push(id);
  };
  for (const [from, to] of edges) if (!candidateIds.has(from)) to.forEach(keep);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) edges.get(id)?.forEach(keep);
  return kept;
}

/**
 * What a sweep with these options would delete, and how many bytes that frees. Reads the database
 * and lists the store; changes neither.
 */
export async function planRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  options: RetentionOptions,
): Promise<RetentionPlan> {
  const candidates = await candidatesOf(db, options);
  const ids = new Set(candidates.map((c) => c.id));
  const kept = referencedBuilds(ids, await referencesAmong(db, candidates));
  const expired: PlannedBuild[] = [];
  // The limit counts what goes, not what is looked at: a chain of expired builds is judged whole.
  for (const build of candidates) {
    if (kept.has(build.id)) continue;
    if (expired.length === options.limit) break;
    const blobs = await storeFor(build.orgId).list(`builds/${build.id}`);
    expired.push({ ...build, blobs });
  }
  return {
    days: options.days,
    cutoff: new Date(options.now.getTime() - options.days * DAY_MS),
    expired,
    keptReferenced: [...kept].toSorted(),
  };
}

/**
 * Delete what `plan` lists: each build's blobs first, then its rows (its shots and their flags go
 * with it), so a sweep that stops half way leaves rows whose blobs are gone, which the next one
 * finishes, never blobs with no row to find them by.
 */
export async function applyRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  plan: RetentionPlan,
): Promise<RetentionResult> {
  const result: RetentionResult = { buildsDeleted: 0, blobsDeleted: 0, bytesFreed: 0 };
  for (const build of plan.expired) {
    await storeFor(build.orgId).deleteMany(build.blobs.map((b) => b.key));
    await db.delete(builds).where(eq(builds.id, build.id));
    result.buildsDeleted += 1;
    result.blobsDeleted += build.blobs.length;
    result.bytesFreed += build.blobs.reduce((sum, b) => sum + b.size, 0);
  }
  await dropEvidenceOf(db, plan.expired);
  return result;
}

/** A flake keeps its row and its other evidence; what a deleted build contributed goes. */
async function dropEvidenceOf(db: Db, deleted: PlannedBuild[]): Promise<void> {
  const gone = new Set(deleted.map((b) => b.id));
  const projectIds = [...new Set(deleted.map((b) => b.projectId))];
  const rows = await inChunks(projectIds, 0, (part) =>
    db
      .select({ id: flakes.id, evidence: flakes.evidence })
      .from(flakes)
      .where(inArray(flakes.projectId, part)),
  );
  for (const row of rows) {
    const kept = row.evidence.filter((e) => !gone.has(e.buildId));
    if (kept.length === row.evidence.length) continue;
    await db.update(flakes).set({ evidence: kept }).where(eq(flakes.id, row.id));
  }
}

/**
 * Plan a sweep and, unless `dryRun`, carry it out. A dry run reads and lists and nothing else: it
 * is the default everywhere a sweep is started, and deleting is always the caller saying so.
 */
export async function sweepRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  options: RetentionOptions & { dryRun: boolean },
): Promise<{ plan: RetentionPlan; result: RetentionResult | null }> {
  const plan = await planRetention(db, storeFor, options);
  if (options.dryRun) return { plan, result: null };
  return { plan, result: await applyRetention(db, storeFor, plan) };
}
