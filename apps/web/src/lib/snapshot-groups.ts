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

type Decidable = {
  diffStatus: DiffStatus | null;
  carriedFrom: string | null;
  /** The web shot whose accepted change made this native shot stale (PS-297); null on every other shot. */
  staleOf?: string | null;
};

/**
 * A shot a reviewer decides on: a change measured on this build, or one carried from the branch's
 * previous build because this shot is identical to it while that change is undecided (ob 1712). A
 * carried shot is `unchanged` (that is what was measured here), yet the change it carries is open.
 * A pending new shot is open too (PS-284): on a branch it waits for review like a change. So is a
 * native shot found unchanged while its twin key is stale (PS-297, `staleOf`): the screen it shows
 * was not looked at since the web side changed, so it waits for a reviewer to accept it.
 */
export function holdsChange(row: Decidable): boolean {
  return (
    row.diffStatus === "changed" ||
    row.diffStatus === "new" ||
    row.carriedFrom !== null ||
    (row.staleOf ?? null) !== null
  );
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
 * Why a shot waits for a reviewer when the diff found nothing in it (PS-297): `stale`, a native
 * shot whose twin key a web change left unreviewed. Null for every other shot, a changed, new or
 * carried one included, whose own words say why.
 */
export function awaitsReason(row: Review): "stale" | null {
  if (!awaitsDecision(row)) return null;
  const measuredChange = row.diffStatus === "changed" || row.diffStatus === "new";
  return (row.staleOf ?? null) !== null && !measuredChange && row.carriedFrom === null
    ? "stale"
    : null;
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

/**
 * The group a reviewer finds the shot under (PS-285). A shot carried from main is `unchanged`
 * against the branch's previous build, yet differs from main and waits for a decision (PS-284), so
 * the page, the check table and the review order file it under its against-main status, `changed`
 * or `new`. A native shot unchanged while its twin key is stale (PS-297) is filed under `changed`,
 * where the reviewer looks. Everything else is `groupOf`. The API keeps `groupOf` (invariant 7).
 */
export function reviewGroupOf(row: {
  diffStatus: DiffStatus | null;
  rebaselineNeeded: boolean;
  carriedFrom: string | null;
  mainDiffStatus: DiffStatus | null;
  staleOf?: string | null;
}): SnapshotGroup {
  const group = groupOf(row);
  if (group !== "unchanged") return group;
  // A stale native shot (PS-297) waits for a decision like a change, so it is found with them.
  if (row.carriedFrom === null) return (row.staleOf ?? null) !== null ? "changed" : group;
  return row.mainDiffStatus === "changed" || row.mainDiffStatus === "new"
    ? row.mainDiffStatus
    : group;
}
