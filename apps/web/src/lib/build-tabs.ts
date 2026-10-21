import { type SnapshotGroup, groupOf } from "./snapshot-groups";

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

type Reviewable = { id: string; diffStatus: string | null; reviewState: string };

/** The first changed shot still waiting for a decision, in the build's order. */
export function firstToReview<T extends Reviewable>(rows: T[]): T | undefined {
  return rows.find((row) => row.diffStatus === "changed" && row.reviewState === "pending");
}
