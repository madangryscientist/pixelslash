import { type SQL, isNull, ne, or } from "drizzle-orm";
import { type DiffStatus, snapshots } from "./schema";

/**
 * The one place that decides a `snapshots` row is a removed marker (ob 1558): a row the diff
 * wrote for a shot the baseline build had and this one does not. It names the baseline build's
 * blob without owning it (see `snapshots`), so it is never a delivery, a bill, a baseline or an
 * image of its own build. Every query that counts, bills or picks a baseline goes through these.
 */
export function isMarker(row: { diffStatus: DiffStatus | null }): boolean {
  return row.diffStatus === "removed";
}

/** Every row that is not a marker: a shot the build holds. A re-baseline row has no status yet. */
export function heldShot(): SQL | undefined {
  return or(isNull(snapshots.diffStatus), ne(snapshots.diffStatus, "removed"));
}
