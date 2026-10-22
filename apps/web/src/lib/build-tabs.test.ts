import { describe, expect, test } from "vitest";
import { defaultTab, firstToReview, tabCounts } from "./build-tabs";

const row = (
  diffStatus: "changed" | "new" | "removed" | "unchanged" | null,
  rebaselineNeeded = false,
) => ({
  diffStatus,
  rebaselineNeeded,
});

describe("tabCounts", () => {
  test("a shot that was never compared is Not measured, never Unchanged", () => {
    const counts = tabCounts([row("changed"), row(null), row(null, true), row("unchanged")]);
    expect(counts).toEqual({ changed: 1, new: 0, removed: 0, unmeasured: 2, unchanged: 1 });
  });
});

describe("defaultTab", () => {
  test("opens on Changed, then New, and never on Unchanged", () => {
    expect(defaultTab({ changed: 3, new: 1, removed: 0, unmeasured: 0, unchanged: 142 })).toBe(
      "changed",
    );
    expect(defaultTab({ changed: 0, new: 145, removed: 0, unmeasured: 0, unchanged: 0 })).toBe(
      "new",
    );
    expect(defaultTab({ changed: 0, new: 0, removed: 0, unmeasured: 0, unchanged: 9 })).toBe(
      "changed",
    );
  });
});

describe("firstToReview", () => {
  test("skips decided and non-changed shots", () => {
    const rows = [
      { id: "a", diffStatus: "new", reviewState: "pending", carriedFrom: null },
      { id: "b", diffStatus: "changed", reviewState: "accepted", carriedFrom: null },
      { id: "c", diffStatus: "changed", reviewState: "pending", carriedFrom: null },
    ] as const;
    expect(firstToReview(rows)?.id).toBe("c");
    expect(firstToReview(rows.slice(0, 2))).toBeUndefined();
  });

  test("an unchanged shot that carries an open change is to review (ob 1712)", () => {
    const rows = [
      { id: "a", diffStatus: "unchanged", reviewState: "pending", carriedFrom: null },
      { id: "b", diffStatus: "unchanged", reviewState: "pending", carriedFrom: "root" },
    ] as const;
    expect(firstToReview(rows)?.id).toBe("b");
  });
});
