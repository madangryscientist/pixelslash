import type { DiffStatus } from "#/db/schema";

/** The order the review walks in: what needs a decision first, what needs none last. */
export const SNAPSHOT_GROUPS = ["changed", "new", "removed", "unchanged", "rebaseline"] as const;
export type SnapshotGroup = (typeof SNAPSHOT_GROUPS)[number];

export const GROUP_LABEL: Record<SnapshotGroup, string> = {
  changed: "Changed",
  new: "New",
  removed: "Removed",
  unchanged: "Unchanged",
  rebaseline: "Needs a new baseline",
};

/**
 * `rebaseline` is not a diff status: it is a row the server could not compare because its
 * baseline came from another environment. It is shown, never counted as a change.
 */
export function groupOf(row: { diffStatus: DiffStatus | null }): SnapshotGroup {
  if (row.diffStatus === null) return "rebaseline";
  return row.diffStatus;
}
