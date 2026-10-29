import { describe, expect, test } from "vitest";
import { defaultTab, firstToReview, nextToReviewId, setsBaseline, tabCounts } from "./build-tabs";

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

const newShot = (reviewState: string) => ({ diffStatus: "new" as const, reviewState });

describe("setsBaseline", () => {
  test("a first build of accepted new shots sets the baseline; one still waiting for review does not (PS-284)", () => {
    expect(setsBaseline(true, [newShot("accepted")])).toBe(true);
    expect(setsBaseline(true, [newShot("pending")])).toBe(false);
    expect(setsBaseline(false, [newShot("accepted")])).toBe(false);
  });
});

describe("firstToReview", () => {
  const steady = { flakeId: null, flakyPolicy: null } as const;

  test("skips decided and unchanged shots, a pending new shot is to review (PS-284)", () => {
    const rows = [
      { id: "a", diffStatus: "unchanged", reviewState: "pending", carriedFrom: null, ...steady },
      { id: "b", diffStatus: "changed", reviewState: "accepted", carriedFrom: null, ...steady },
      { id: "c", diffStatus: "new", reviewState: "pending", carriedFrom: null, ...steady },
    ] as const;
    expect(firstToReview(rows)?.id).toBe("c");
    expect(firstToReview(rows.slice(0, 2))).toBeUndefined();
  });

  test("an unchanged shot that carries an open change is to review (ob 1712)", () => {
    const rows = [
      { id: "a", diffStatus: "unchanged", reviewState: "pending", carriedFrom: null, ...steady },
      { id: "b", diffStatus: "unchanged", reviewState: "pending", carriedFrom: "root", ...steady },
    ] as const;
    expect(firstToReview(rows)?.id).toBe("b");
  });

  test("a flaky shot its config skips is not to review (ob 1724)", () => {
    const rows = [
      {
        id: "a",
        diffStatus: "changed",
        reviewState: "pending",
        carriedFrom: null,
        flakeId: "f",
        flakyPolicy: "skip",
      },
      {
        id: "b",
        diffStatus: "changed",
        reviewState: "pending",
        carriedFrom: null,
        flakeId: "f",
        flakyPolicy: "review",
      },
    ] as const;
    expect(firstToReview(rows)?.id).toBe("b");
  });
});

describe("nextToReviewId", () => {
  const steady = { flakeId: null, flakyPolicy: null, carriedFrom: null } as const;
  const shot = (id: string, reviewState: "pending" | "accepted" | "rejected") => ({
    id,
    diffStatus: "changed" as const,
    reviewState,
    ...steady,
  });

  test("searches forward from the shot first, then wraps to the earlier ones", () => {
    const rows = [shot("a", "pending"), shot("b", "pending"), shot("c", "accepted")];
    expect(nextToReviewId(rows, "c")).toBe("a");
    expect(nextToReviewId(rows, "a")).toBe("b");
    expect(nextToReviewId(rows, "b")).toBe("a");
  });

  test("a shot is never its own next, and none left is null", () => {
    const rows = [shot("a", "pending"), shot("b", "accepted")];
    expect(nextToReviewId(rows, "a")).toBeNull();
    expect(nextToReviewId([shot("a", "accepted")], "a")).toBeNull();
  });
});
