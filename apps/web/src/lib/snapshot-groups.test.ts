import { describe, expect, test } from "vitest";
import { awaitsReason, groupOf, reviewGroupOf } from "./snapshot-groups";

describe("groupOf", () => {
  test("a null diff is a re-baseline only when the server marked it, never when it was not measured", () => {
    expect(groupOf({ diffStatus: null, rebaselineNeeded: true })).toBe("rebaseline");
    expect(groupOf({ diffStatus: null, rebaselineNeeded: false })).toBe("unmeasured");
  });

  test("a diffed shot keeps its diff status", () => {
    expect(groupOf({ diffStatus: "changed", rebaselineNeeded: false })).toBe("changed");
  });
});

describe("a stale native shot (PS-297)", () => {
  const unchanged = {
    diffStatus: "unchanged" as const,
    rebaselineNeeded: false,
    carriedFrom: null,
    mainDiffStatus: null,
    flakeId: null,
    flakyPolicy: null,
    reviewState: "pending",
  };

  test("an unchanged shot of a stale key is filed under changed and waits for a reason", () => {
    const stale = { ...unchanged, staleOf: "web-1" };
    expect(groupOf(stale)).toBe("unchanged");
    expect(reviewGroupOf(stale)).toBe("changed");
    expect(awaitsReason(stale)).toBe("stale");
  });

  test("an unchanged shot of a fresh key stays unchanged and gives no reason", () => {
    expect(reviewGroupOf({ ...unchanged, staleOf: null })).toBe("unchanged");
    expect(reviewGroupOf(unchanged)).toBe("unchanged");
    expect(awaitsReason(unchanged)).toBeNull();
  });

  test("a changed shot of a stale key keeps its own words", () => {
    const changed = { ...unchanged, diffStatus: "changed" as const, staleOf: "web-1" };
    expect(reviewGroupOf(changed)).toBe("changed");
    expect(awaitsReason(changed)).toBeNull();
  });
});
