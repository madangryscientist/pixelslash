import { and, eq, isNull } from "drizzle-orm";
import type { BaselineSnapshot } from "#/db/baselines";
import type { Build } from "#/db/builds";
import type { runFields } from "#/db/server-timings";
import type { Db } from "#/db/db";
import { type DiffLocation, builds, projects, snapshots } from "#/db/schema";
import type { ProcessDeps } from "./process";

/**
 * What a diff run writes on a build as a whole, beside each shot's result: its removed markers, the
 * default branch's auto-accept, an error. Shared by a full run (`processBuild`) and a partial
 * re-run (`rerunShots`, ob 1738).
 */

/** A shot the baseline build had and this one does not: a marker row, so reviewers can see it. */
export async function markRemoved(deps: ProcessDeps, build: Build, removed: BaselineSnapshot[]) {
  for (const shot of removed) {
    await deps.db
      .insert(snapshots)
      .values({
        id: crypto.randomUUID(),
        buildId: build.id,
        name: shot.name,
        platform: shot.platform,
        browser: shot.browser,
        viewport: shot.viewport,
        theme: shot.theme,
        envFingerprint: shot.envFingerprint,
        ignore: shot.ignore,
        imageKey: shot.imageKey,
        baselineKey: shot.imageKey,
        diffStatus: "removed",
      })
      .onConflictDoNothing();
  }
}

export type ProjectOfBuild = { defaultBranch: string; diffLocation: DiffLocation };

export async function projectOf(db: Db, build: Build): Promise<ProjectOfBuild> {
  const [project] = await db
    .select({ defaultBranch: projects.defaultBranch, diffLocation: projects.diffLocation })
    .from(projects)
    .where(eq(projects.id, build.projectId));
  if (!project) throw new Error("the build's project is gone");
  return project;
}

/** A build on the project's default branch is auto-accepted: there is no reviewer to ask (ob 1559). */
export async function acceptDefaultBranchBuild(
  db: Db,
  build: Build,
  project: ProjectOfBuild,
): Promise<void> {
  if (build.branch !== project.defaultBranch) return;
  // A flaky shot is never auto-accepted (ob 1724): under `review` it waits, under `skip` it is left.
  await db
    .update(snapshots)
    .set({ reviewState: "accepted", reviewedAt: new Date() })
    .where(and(eq(snapshots.buildId, build.id), isNull(snapshots.flakeId)));
}

/**
 * Why a run failed, as the build says it. Drizzle wraps a database error in "Failed query: <sql>",
 * which hides what the database said; the cause is added, so a locked database reads as one (PS-228).
 */
export function reasonOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return cause && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
}

/**
 * `timings`: the server timings (ob 1792) the end of the run writes with its error, if it has any.
 * Returns the reason it stored, for a reply that must say the same.
 */
export async function markErrored(
  db: Db,
  build: Build,
  e: unknown,
  timings: Partial<ReturnType<typeof runFields>> = {},
): Promise<string> {
  const error = reasonOf(e);
  await db
    .update(builds)
    .set({ ...timings, status: "errored", error })
    .where(eq(builds.id, build.id));
  return error;
}

/**
 * Drop the removed markers an earlier run wrote; the run writes the ones the baseline calls for.
 * Everything else an earlier run stored stays, so a re-run resumes instead of starting over
 * (ob 1645). The uploaded shots are what usage counts and are never touched.
 */
export async function clearMarkers(deps: ProcessDeps, build: Build): Promise<void> {
  await deps.db
    .delete(snapshots)
    .where(and(eq(snapshots.buildId, build.id), eq(snapshots.diffStatus, "removed")));
}

/** What a shot compared with nothing holds of a comparison: none of it, its compare time included. */
export const UNCOMPARED = {
  diffStatus: null,
  diffResult: null,
  rebaselineNeeded: false,
  diffKey: null,
  carriedFrom: null,
  measuredBy: null,
  engineVersion: null,
  diffError: null,
  aiReview: null,
  diffMs: null,
} as const;
