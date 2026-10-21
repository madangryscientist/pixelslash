import { describe, expect, it } from "vitest";
import { reviewKeyAction } from "#/lib/use-review-keys";

describe("reviewKeyAction", () => {
  it("maps j/k to walking and a/r to a decision while the build is reviewable", () => {
    expect(reviewKeyAction("j", true)).toBe("next");
    expect(reviewKeyAction("k", true)).toBe("previous");
    expect(reviewKeyAction("a", true)).toBe("accepted");
    expect(reviewKeyAction("r", true)).toBe("rejected");
    expect(reviewKeyAction("x", true)).toBeNull();
  });

  it("keeps j/k walking on a failed build and does nothing for a/r", () => {
    expect(reviewKeyAction("j", false)).toBe("next");
    expect(reviewKeyAction("k", false)).toBe("previous");
    expect(reviewKeyAction("a", false)).toBeNull();
    expect(reviewKeyAction("r", false)).toBeNull();
  });
});
