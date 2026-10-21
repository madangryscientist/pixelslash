import { describe, expect, test } from "vitest";
import { groupOf } from "./snapshot-groups";

describe("groupOf", () => {
  test("a null diff is a re-baseline only when the server marked it, never when it was not measured", () => {
    expect(groupOf({ diffStatus: null, rebaselineNeeded: true })).toBe("rebaseline");
    expect(groupOf({ diffStatus: null, rebaselineNeeded: false })).toBe("unmeasured");
  });

  test("a diffed shot keeps its diff status", () => {
    expect(groupOf({ diffStatus: "changed", rebaselineNeeded: false })).toBe("changed");
  });
});
