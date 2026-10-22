import type { DiffStatus, FlakyPolicy } from "#/db/schema";

/** The order the review walks in: what needs a decision first, what needs none last. */
export const SNAPSHOT_GROUPS = [
  "changed",
  "new",
  "removed",
  "unchanged",
  "rebaseline",
  "unmeasured",
] as const;
export type SnapshotGroup = (typeof SNAPSHOT_GROUPS)[number];

export const GROUP_LABEL: Record<SnapshotGroup, string> = {
  changed: "Changed",
  new: "New",
  removed: "Removed",
  unchanged: "Unchanged",
  rebaseline: "Needs a new baseline",
  unmeasured: "Not measured",
};

type Decidable = { diffStatus: DiffStatus | null; carriedFrom: string | null };

/**
 * A shot a reviewer decides on: a change measured on this build, or one carried from the branch's
 * previous build because this shot is identical to it while that change is undecided (ob 1712). A
 * carried shot is `unchanged` (that is what was measured here), yet the change it carries is open.
 */
export function holdsChange(row: Decidable): boolean {
  return row.diffStatus === "changed" || row.carriedFrom !== null;
}

type Flaky = { flakeId: string | null; flakyPolicy: FlakyPolicy | null };
type Review = Decidable & Flaky & { reviewState: string };

/**
 * A flaky shot whose config says `skip` (ob 1724), holding a change nobody decided: labelled
 * "skipped: flaky", it waits for nobody and never blocks its build. It is not accepted either: its
 * baseline stays where it was. With no policy sent the shot is `review`, and waits like any change.
 */
export function skippedFlaky(row: Review): boolean {
  return (
    row.flakeId !== null &&
    row.flakyPolicy === "skip" &&
    row.reviewState === "pending" &&
    holdsChange(row)
  );
}

/** A shot that waits for a reviewer: it holds a change nobody has decided yet, and is not skipped as flaky. */
export function awaitsDecision(row: Review): boolean {
  return row.reviewState === "pending" && holdsChange(row) && !skippedFlaky(row);
}

/**
 * `rebaseline` is not a diff status: it is a row the server could not compare because its
 * baseline came from another environment (`rebaselineNeeded`). It is shown, never counted as a
 * change. A null diff without that mark was never compared at all (an errored build): it is
 * `unmeasured`, never a re-baseline.
 */
export function groupOf(row: {
  diffStatus: DiffStatus | null;
  rebaselineNeeded: boolean;
}): SnapshotGroup {
  if (row.diffStatus !== null) return row.diffStatus;
  return row.rebaselineNeeded ? "rebaseline" : "unmeasured";
}
