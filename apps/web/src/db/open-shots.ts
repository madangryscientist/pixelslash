import { eq } from "drizzle-orm";
import { awaitsDecision } from "#/lib/snapshot-groups";
import type { Db } from "./db";
import { snapshots } from "./schema";

/** A shot waiting for a decision, named for a place that cannot show the build page (the check run). */
export type OpenShot = { name: string; viewport: string; theme: string; kind: "changed" | "new" };

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
      kind:
        diffStatus === "new" || (diffStatus !== "changed" && mainDiffStatus === "new")
          ? ("new" as const)
          : ("changed" as const),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.viewport.localeCompare(b.viewport));
}
