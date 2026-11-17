import { describe, expect, test } from "vitest";
import { summaryCounts } from "./summary-counts";

const shot = (over: object = {}) => ({
  diffStatus: "unchanged" as const,
  rebaselineNeeded: false,
  carriedFrom: null,
  mainDiffStatus: null,
  ...over,
});

describe("the counts line under a build's summary", () => {
  test("a shot carried from main is stated, and the line does not say nothing changed", () => {
    const line = summaryCounts(
      [
        shot({ carriedFrom: "a", mainDiffStatus: "changed" }),
        shot({ carriedFrom: "b", mainDiffStatus: "new" }),
        shot(),
      ],
      null,
    );
    expect(line).toBe(
      "1 changed and 1 new carried from main: no change since the previous build, but they still differ from main · 1 unchanged.",
    );
  });

  test("nothing changed is said so, and with a brief says there was nothing to read it against", () => {
    expect(summaryCounts([shot()], null)).toBe("Nothing changed. 1 unchanged.");
    expect(summaryCounts([shot()], "make it blue")).toBe(
      "Nothing changed, so there is nothing to read against the brief. 1 unchanged.",
    );
  });

  test("a measured change leads with the counts alone, and unmeasured shots are named, never unchanged", () => {
    expect(summaryCounts([shot({ diffStatus: "changed" }), shot()], null)).toBe("1 unchanged.");
    expect(summaryCounts([shot({ diffStatus: null }), shot({ diffStatus: null })], null)).toBe(
      "Nothing changed. 0 unchanged · 2 shots not measured: not compared, so not known to be unchanged.",
    );
  });

  test("regions the model labelled noise are counted", () => {
    const noisy = shot({
      diffStatus: "changed",
      aiReview: { regions: [{ label: "noise" }, { label: "change" }, { label: "noise" }] },
    });
    expect(summaryCounts([noisy], null)).toBe("0 unchanged · 2 regions labelled likely noise.");
  });
});
