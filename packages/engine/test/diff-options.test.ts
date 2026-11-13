import { describe, expect, test } from "vitest";
import { DEFAULT_THRESHOLD, type DiffOptions } from "../src/diff.ts";
import {
  describeDiffOptions,
  mergeDiffOptions,
  parseDiffOption,
  parseDiffOptions,
  type Fail,
} from "../src/diff-options.ts";
import {
  DEFAULT_MERGE_DISTANCE,
  DEFAULT_MIN_REGION_AREA,
  DEFAULT_NOISE_AMPLITUDE,
} from "../src/regions.ts";
import { DEFAULT_MAX_SHIFT } from "../src/shift.ts";

/** Reports through a throw, so a test sees exactly what `where` and `what` the caller would. */
class Refused extends Error {
  constructor(
    readonly where: string,
    readonly what: string,
  ) {
    super(`${where} ${what}`);
  }
}
const fail: Fail = (where, what) => {
  throw new Refused(where, what);
};

function refusal(run: () => unknown): Refused {
  try {
    run();
  } catch (e) {
    if (e instanceof Refused) return e;
    throw e;
  }
  throw new Error("expected the value to be refused");
}

const UNIT = "must be a number from 0 to 1";
const COUNT = "must be a non-negative integer";

const UNIT_KEYS = ["threshold", "minChangedRatio", "noiseAmplitude", "maxShift"] as const;
const COUNT_KEYS = ["minChangedPixels", "mergeDistance", "minRegionArea"] as const;

describe("parseDiffOptions refuses a bad value, naming the key", () => {
  test.each(
    UNIT_KEYS.flatMap((key) =>
      [NaN, Infinity, -0.1, 1.5, "0.1", null, true].map((v) => [key, v] as const),
    ),
  )("%s: %j is not a number from 0 to 1", (key, value) => {
    const e = refusal(() => parseDiffOptions({ [key]: value }, "diff", fail));
    expect(e.where).toBe(`diff.${key}`);
    expect(e.what).toBe(UNIT);
  });

  test.each(
    COUNT_KEYS.flatMap((key) =>
      [NaN, Infinity, -1, 2.5, "3", null, false].map((v) => [key, v] as const),
    ),
  )("%s: %j is not a non-negative integer", (key, value) => {
    const e = refusal(() => parseDiffOptions({ [key]: value }, "diff", fail));
    expect(e.where).toBe(`diff.${key}`);
    expect(e.what).toBe(COUNT);
  });

  test("a count above 1 is fine where a unit above 1 is not", () => {
    expect(parseDiffOptions({ minChangedPixels: 40 }, "diff", fail)).toEqual({
      minChangedPixels: 40,
    });
    expect(refusal(() => parseDiffOptions({ maxShift: 40 }, "diff", fail)).where).toBe(
      "diff.maxShift",
    );
  });

  test("the bounds themselves are accepted: 0 and 1 for a unit, 0 for a count", () => {
    for (const key of UNIT_KEYS) {
      expect(parseDiffOptions({ [key]: 0 }, "diff", fail)).toEqual({ [key]: 0 });
      expect(parseDiffOptions({ [key]: 1 }, "diff", fail)).toEqual({ [key]: 1 });
    }
    for (const key of COUNT_KEYS) {
      expect(parseDiffOptions({ [key]: 0 }, "diff", fail)).toEqual({ [key]: 0 });
    }
  });

  test("the caller's `where` prefixes the key", () => {
    const e = refusal(() => parseDiffOptions({ threshold: 2 }, "routes[0].diff", fail));
    expect(e.where).toBe("routes[0].diff.threshold");
  });

  test("parseDiffOption on its own uses the where it is given", () => {
    for (const key of UNIT_KEYS) {
      const e = refusal(() => parseDiffOption(key, 1.5, "--flag", fail));
      expect([e.where, e.what]).toEqual(["--flag", UNIT]);
    }
    for (const key of COUNT_KEYS) {
      const e = refusal(() => parseDiffOption(key, 2.5, "--flag", fail));
      expect([e.where, e.what]).toEqual(["--flag", COUNT]);
    }
    expect(parseDiffOption("threshold", 0.2, "--flag", fail)).toBe(0.2);
    expect(parseDiffOption("minChangedPixels", 7, "--flag", fail)).toBe(7);
  });
});

describe("parseDiffOptions refuses what is not a diff object", () => {
  test.each([
    ["a string", "0.1"],
    ["a number", 3],
    ["null", null],
    ["an array", []],
    ["undefined", undefined],
  ])("%s", (_, value) => {
    const e = refusal(() => parseDiffOptions(value, "diff", fail));
    expect(e.where).toBe("diff");
    expect(e.what).toMatch(/^must be an object with threshold, /);
  });

  test("an unknown key is refused by name, with the keys that exist", () => {
    const e = refusal(() => parseDiffOptions({ threshold: 0.1, treshold: 0.2 }, "diff", fail));
    expect(e.where).toBe("diff.treshold");
    expect(e.what).toMatch(/^is not a diff option \(threshold, minChangedPixels, /);
  });

  test("an unknown key is refused even when every known key is valid", () => {
    expect(refusal(() => parseDiffOptions({ extra: 1 }, "diff", fail)).where).toBe("diff.extra");
  });

  test("a key named like an Object method is refused", () => {
    expect(refusal(() => parseDiffOptions({ toString: 1 }, "diff", fail)).where).toBe(
      "diff.toString",
    );
  });
});

describe("parseDiffOptions result", () => {
  test("only the given keys appear", () => {
    expect(parseDiffOptions({}, "diff", fail)).toEqual({});
    const got = parseDiffOptions({ threshold: 0.3, minRegionArea: 9 }, "diff", fail);
    expect(Object.keys(got).toSorted()).toEqual(["minRegionArea", "threshold"]);
    expect(got).toEqual({ threshold: 0.3, minRegionArea: 9 });
  });

  test("an undefined value is the same as no key", () => {
    expect(parseDiffOptions({ threshold: undefined }, "diff", fail)).toEqual({});
  });

  test("all seven keys round trip", () => {
    const all: DiffOptions = {
      threshold: 0.05,
      minChangedPixels: 3,
      minChangedRatio: 0.001,
      mergeDistance: 10,
      minRegionArea: 2,
      noiseAmplitude: 0.5,
      maxShift: 0.1,
    };
    expect(parseDiffOptions(all, "diff", fail)).toEqual(all);
  });
});

/** A layer that names a key and leaves it undefined, as a caller spreading an optional would; `DiffOptions` forbids writing it. */
function unset(key: keyof DiffOptions): DiffOptions {
  return Object.fromEntries([[key, undefined]]);
}

describe("mergeDiffOptions", () => {
  test("a later layer wins, key by key", () => {
    expect(
      mergeDiffOptions(
        { threshold: 0.1, minChangedPixels: 5 },
        { threshold: 0.2 },
        { minChangedPixels: 9, mergeDistance: 3 },
      ),
    ).toEqual({ threshold: 0.2, minChangedPixels: 9, mergeDistance: 3 });
  });

  test("order matters: the same layers reversed give the other winner", () => {
    expect(mergeDiffOptions({ threshold: 0.1 }, { threshold: 0.2 }).threshold).toBe(0.2);
    expect(mergeDiffOptions({ threshold: 0.2 }, { threshold: 0.1 }).threshold).toBe(0.1);
  });

  test("an undefined key does not erase an earlier one", () => {
    expect(mergeDiffOptions({ threshold: 0.1 }, unset("threshold"))).toEqual({
      threshold: 0.1,
    });
  });

  test("a later 0 does erase an earlier value: 0 is a setting, not an absence", () => {
    expect(mergeDiffOptions({ threshold: 0.1, minChangedPixels: 5 }, { threshold: 0 })).toEqual({
      threshold: 0,
      minChangedPixels: 5,
    });
  });

  test("defaults are not injected", () => {
    expect(mergeDiffOptions()).toEqual({});
    expect(mergeDiffOptions({}, {})).toEqual({});
    expect(Object.keys(mergeDiffOptions({ maxShift: 0.4 }))).toEqual(["maxShift"]);
  });

  test("the layers are not changed", () => {
    const early: DiffOptions = { threshold: 0.1 };
    const late: DiffOptions = { threshold: 0.2, maxShift: 0.3 };
    mergeDiffOptions(early, late);
    expect(early).toEqual({ threshold: 0.1 });
    expect(late).toEqual({ threshold: 0.2, maxShift: 0.3 });
  });
});

describe("describeDiffOptions", () => {
  test("is empty when nothing differs from the engine defaults", () => {
    expect(describeDiffOptions({})).toBe("");
    expect(
      describeDiffOptions({
        threshold: DEFAULT_THRESHOLD,
        minChangedPixels: 0,
        minChangedRatio: 0,
        mergeDistance: DEFAULT_MERGE_DISTANCE,
        minRegionArea: DEFAULT_MIN_REGION_AREA,
        noiseAmplitude: DEFAULT_NOISE_AMPLITUDE,
        maxShift: DEFAULT_MAX_SHIFT,
      }),
    ).toBe("");
  });

  test("names the keys that differ, labelled, in key order and joined with a dot", () => {
    expect(describeDiffOptions({ minChangedPixels: 50, threshold: 0.2 })).toBe(
      "threshold 0.2 · min changed pixels 50",
    );
  });

  test("a value equal to its default is left out beside one that differs", () => {
    expect(
      describeDiffOptions({
        threshold: DEFAULT_THRESHOLD,
        mergeDistance: DEFAULT_MERGE_DISTANCE + 1,
      }),
    ).toBe(`merge distance ${DEFAULT_MERGE_DISTANCE + 1}`);
  });

  test("a 0 where the default is not 0 is a difference", () => {
    expect(describeDiffOptions({ threshold: 0, minChangedPixels: 0 })).toBe("threshold 0");
  });

  test("every key has a label", () => {
    expect(
      describeDiffOptions({
        threshold: 0.5,
        minChangedPixels: 1,
        minChangedRatio: 0.5,
        mergeDistance: 1,
        minRegionArea: 1,
        noiseAmplitude: 0.5,
        maxShift: 0.5,
      }),
    ).toBe(
      "threshold 0.5 · min changed pixels 1 · min changed ratio 0.5 · merge distance 1 · min region area 1 · noise amplitude 0.5 · max shift 0.5",
    );
  });
});
