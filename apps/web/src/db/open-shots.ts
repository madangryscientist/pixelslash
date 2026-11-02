import { eq } from "drizzle-orm";
import { awaitsDecision, holdsChange } from "#/lib/snapshot-groups";
import type { Db } from "./db";
import { snapshots } from "./schema";

/** A shot waiting for a decision, named for a place that cannot show the build page (the check run). */
export type OpenShot = { name: string; viewport: string; theme: string; kind: "changed" | "new" };

type Status = typeof snapshots.$inferSelect.diffStatus;

const kindOf = (diffStatus: Status, mainDiffStatus: Status): OpenShot["kind"] =>
  diffStatus === "new" || (diffStatus !== "changed" && mainDiffStatus === "new")
    ? "new"
    : "changed";

/**
 * The shots of a build that wait for a decision, by name. `new` is a shot with nothing to compare
 * against, or one that carries a change from main that was new there (PS-284); any other is a change.
 */
export async function openShotsOf(db: Db, buildId: string): Promise<OpenShot[]> {
  const rows = await db
    .select({
      name: snapshots.name,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      diffStatus: snapshots.diffStatus,
      mainDiffStatus: snapshots.mainDiffStatus,
      reviewState: snapshots.reviewState,
      carriedFrom: snapshots.carriedFrom,
      flakeId: snapshots.flakeId,
      flakyPolicy: snapshots.flakyPolicy,
    })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  return rows
    .filter(awaitsDecision)
    .map(({ name, viewport, theme, diffStatus, mainDiffStatus }) => ({
      name,
      viewport,
      theme,
      kind: kindOf(diffStatus, mainDiffStatus),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.viewport.localeCompare(b.viewport));
}

/** A shot that holds a change, for a place that links to it (the PR comment, PS-82). */
export type ChangedShot = OpenShot & { id: string; changedPixels: number };

/**
 * The build's shots that hold a change, the most changed first: by changed pixels, with shots that
 * have no measurement against a baseline (new ones) after the measured, by name. Decided shots
 * count too: the comment says where the build changed, not what is still open.
 */
export async function mostChangedShots(
  db: Db,
  buildId: string,
  limit: number,
): Promise<ChangedShot[]> {
  const rows = await db
    .select({
      id: snapshots.id,
      name: snapshots.name,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      diffStatus: snapshots.diffStatus,
      mainDiffStatus: snapshots.mainDiffStatus,
      diffResult: snapshots.diffResult,
      mainDiffResult: snapshots.mainDiffResult,
      carriedFrom: snapshots.carriedFrom,
    })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  return rows
    .filter(holdsChange)
    .map(
      ({ id, name, viewport, theme, diffStatus, mainDiffStatus, diffResult, mainDiffResult }) => ({
        id,
        name,
        viewport,
        theme,
        kind: kindOf(diffStatus, mainDiffStatus),
        changedPixels: (diffStatus === "changed" ? diffResult : mainDiffResult)?.changedPixels ?? 0,
      }),
    )
    .toSorted(
      (a, b) =>
        b.changedPixels - a.changedPixels ||
        a.name.localeCompare(b.name) ||
        a.viewport.localeCompare(b.viewport),
    )
    .slice(0, limit);
}
