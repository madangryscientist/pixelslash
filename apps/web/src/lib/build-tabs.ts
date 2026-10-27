import { type SnapshotGroup, awaitsDecision, groupOf } from "./snapshot-groups";

/**
 * The build page's tabs. `Not measured` holds both kinds of shot that were never compared (no
 * measurement at all, and a baseline from another environment): neither is "unchanged", and the
 * page says so rather than folding them into a count that reads as good news.
 */
export type BuildTab = "changed" | "new" | "removed" | "unmeasured" | "unchanged";

export const BUILD_TABS: readonly { id: BuildTab; label: string; groups: SnapshotGroup[] }[] = [
  { id: "changed", label: "Changed", groups: ["changed"] },
  { id: "new", label: "New", groups: ["new"] },
  { id: "removed", label: "Removed", groups: ["removed"] },
  { id: "unmeasured", label: "Not measured", groups: ["unmeasured", "rebaseline"] },
  { id: "unchanged", label: "Unchanged", groups: ["unchanged"] },
];

type Row = Parameters<typeof groupOf>[0];

export function tabCounts(rows: Row[]): Record<BuildTab, number> {
  const counts: Record<BuildTab, number> = {
    changed: 0,
    new: 0,
    removed: 0,
    unmeasured: 0,
    unchanged: 0,
  };
  for (const row of rows) {
    const group = groupOf(row);
    const tab = BUILD_TABS.find((candidate) => candidate.groups.includes(group));
    if (tab) counts[tab.id] += 1;
  }
  return counts;
}

/** Where the page opens: what needs a decision first. Unchanged is never the default. */
export function defaultTab(counts: Record<BuildTab, number>): BuildTab {
  return (
    (["changed", "new", "removed", "unmeasured"] as const).find((id) => counts[id] > 0) ?? "changed"
  );
}

/**
 * A build that sets the project's baseline: the first one the project has, and every shot in it is
 * `new`. A later build whose shots are all new (a new environment, say) still has a baseline to
 * compare against elsewhere, so it keeps its review actions.
 */
export function setsBaseline(
  firstBuild: boolean,
  snapshots: { diffStatus: string | null }[],
): boolean {
  return firstBuild && snapshots.length > 0 && snapshots.every((shot) => shot.diffStatus === "new");
}

type Reviewable = { id: string } & Parameters<typeof awaitsDecision>[0];

/** The first shot still waiting for a decision, in the build's order. */
export function firstToReview<T extends Reviewable>(rows: readonly T[]): T | undefined {
  return rows.find(awaitsDecision);
}

/**
 * The shot still waiting for a decision after `id` (which must be one of `rows`): forward from it
 * first, then wrapping to the earlier ones. `id` itself is never its own next.
 */
export function nextToReviewId(rows: readonly Reviewable[], id: string): string | null {
  const at = rows.findIndex((row) => row.id === id);
  return (firstToReview(rows.slice(at + 1)) ?? firstToReview(rows.slice(0, at)))?.id ?? null;
}
