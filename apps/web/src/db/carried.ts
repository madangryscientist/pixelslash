import { type SQL, and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { Db } from "./db";
import { builds, snapshots } from "./schema";

/**
 * A carried shot (ob 1712) and the shot it carries from are one change seen on several builds of
 * a branch, so a decision on any of them is the decision on all. The group is the root (the shot
 * that measured the change) and every shot whose `carriedFrom` names it.
 */
export type Decision = {
  reviewState: "accepted" | "rejected";
  reviewedBy: string;
  reviewedAt: Date;
};

/** The group of one shot, given its root: `carriedFrom ?? id`. */
export function groupOfShot(root: string): SQL | undefined {
  return or(eq(snapshots.id, root), eq(snapshots.carriedFrom, root));
}

/** The groups of every shot in a build: their roots, their carriers, and the roots' carriers. */
export function groupsOfBuild(db: Db, buildId: string): SQL | undefined {
  const ids = db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.buildId, buildId));
  const roots = db
    .select({ id: snapshots.carriedFrom })
    .from(snapshots)
    .where(and(eq(snapshots.buildId, buildId), isNotNull(snapshots.carriedFrom)));
  return or(
    inArray(snapshots.id, roots),
    inArray(snapshots.carriedFrom, ids),
    inArray(snapshots.carriedFrom, roots),
  );
}

/**
 * Apply a decision to the rest of a group. Only shots of the project's reviewable builds move: a
 * failed build stays failed until a new build arrives. Returns the builds whose shots moved, so
 * the caller can move each to its verdict.
 */
export async function decideGroup(
  db: Db,
  projectId: string,
  members: SQL | undefined,
  decision: Decision,
): Promise<string[]> {
  const reviewable = db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), inArray(builds.status, ["changes", "passed"])));
  const where = and(
    members,
    ne(snapshots.reviewState, decision.reviewState),
    inArray(snapshots.buildId, reviewable),
  );
  const moved = await db
    .selectDistinct({ buildId: snapshots.buildId })
    .from(snapshots)
    .where(where);
  if (moved.length > 0) await db.update(snapshots).set(decision).where(where);
  return moved.map((row) => row.buildId);
}

/** The build that holds each shot a shot of this build carries from, keyed by that shot's id. */
export async function carriedRootBuilds(db: Db, buildId: string): Promise<Map<string, string>> {
  const roots = await db
    .select({ id: snapshots.id, buildId: snapshots.buildId })
    .from(snapshots)
    .where(
      inArray(
        snapshots.id,
        db
          .select({ id: snapshots.carriedFrom })
          .from(snapshots)
          .where(and(eq(snapshots.buildId, buildId), isNotNull(snapshots.carriedFrom))),
      ),
    );
  return new Map(roots.map((root) => [root.id, root.buildId]));
}
