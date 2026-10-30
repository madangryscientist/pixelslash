import { describe, expect, test } from "vitest";
import {
  MAX_TEXT,
  MAX_VIOLATIONS,
  diffA11y,
  parseA11yEntry,
  type A11y,
  type A11yViolation,
} from "../src/a11y-entry.ts";
import { flatten } from "../src/a11y.ts";
import { parseConfig } from "../src/config.ts";

const fail = (where: string, what: string): never => {
  throw new Error(`${where} ${what}`);
};
const v = (
  rule: string,
  selector: string,
  impact: A11yViolation["impact"] = "serious",
): A11yViolation => ({
  rule,
  impact,
  help: `${rule} help`,
  selector,
});

describe("parseA11yEntry", () => {
  test("absent is not scanned", () => {
    expect(parseA11yEntry(undefined, "a11y", fail)).toBeUndefined();
  });

  test("an empty scan is kept: the page was scanned and clean", () => {
    expect(parseA11yEntry({ violations: [] }, "a11y", fail)).toEqual({ violations: [] });
  });

  test("round trips violations and omitted", () => {
    const a11y: A11y = { violations: [v("label", "#email"), v("x", "p", null)], omitted: 3 };
    expect(parseA11yEntry(JSON.parse(JSON.stringify(a11y)), "a11y", fail)).toEqual(a11y);
  });

  test.each([
    ["a non-object", 3, "a11y must be { violations }"],
    ["no violations array", {}, "a11y.violations must be an array"],
    ["a non-object violation", { violations: [1] }, "a11y.violations[0] must be an object"],
    [
      "an unknown impact",
      { violations: [{ ...v("a", "b"), impact: "huge" }] },
      "a11y.violations[0].impact must be null or minor, moderate, serious, critical",
    ],
    [
      "an empty selector",
      { violations: [{ ...v("a", "b"), selector: "" }] },
      "a11y.violations[0].selector must be a non-empty string",
    ],
    [
      "a selector over the cap",
      { violations: [v("a", "x".repeat(MAX_TEXT + 1))] },
      `a11y.violations[0].selector must be at most ${MAX_TEXT} characters`,
    ],
    [
      "too many violations",
      { violations: Array.from({ length: MAX_VIOLATIONS + 1 }, () => v("a", "b")) },
      `a11y.violations must have at most ${MAX_VIOLATIONS} violations`,
    ],
    ["omitted of zero", { violations: [], omitted: 0 }, "a11y.omitted must be a positive integer"],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parseA11yEntry(input, "a11y", fail)).toThrow(message);
  });
});

describe("diffA11y", () => {
  const label = v("label", "#email");
  const contrast = v("color-contrast", "#faint");

  test("Branch not scanned: nothing is claimed, whatever Main has", () => {
    expect(diffA11y(undefined, undefined)).toEqual({ state: "off" });
    expect(diffA11y({ violations: [label] }, undefined)).toEqual({ state: "off" });
  });

  test("Main not scanned: nothing is called new", () => {
    expect(diffA11y(undefined, { violations: [label] })).toEqual({
      state: "unbaselined",
      found: [label],
      omitted: 0,
    });
  });

  test("new is on Branch and not on Main; the same rule on another element is new", () => {
    const d = diffA11y(
      { violations: [label] },
      { violations: [label, contrast, v("label", "#other")] },
    );
    expect(d).toEqual({
      state: "compared",
      fresh: [contrast, v("label", "#other")],
      already: [label],
      omitted: 0,
    });
  });

  test("a violation fixed on Branch is not reported", () => {
    const d = diffA11y({ violations: [label, contrast] }, { violations: [label] });
    expect(d).toMatchObject({ state: "compared", fresh: [], already: [label] });
  });

  test("omitted from either side is carried, since a cut violation may be the new one", () => {
    const d = diffA11y({ violations: [], omitted: 2 }, { violations: [], omitted: 5 });
    expect(d).toMatchObject({ state: "compared", omitted: 7 });
  });
});

describe("flatten", () => {
  test("one violation per failing element, frame hops joined, over-long text cut", () => {
    const out = flatten([
      {
        id: "label",
        impact: "critical",
        help: "h".repeat(MAX_TEXT + 10),
        nodes: [{ target: ["#a"] }, { target: [["iframe", "#b"]] }],
      },
      { id: "x", impact: null, help: "x", nodes: [{ target: ["#c"] }] },
    ]);
    expect(out.violations.map((x) => [x.rule, x.selector, x.impact])).toEqual([
      ["label", "#a", "critical"],
      ["label", "iframe >> #b", "critical"],
      ["x", "#c", null],
    ]);
    expect(out.violations[0]?.help).toHaveLength(MAX_TEXT);
    expect(out).not.toHaveProperty("omitted");
  });

  test("past the cap the rest is counted, not kept", () => {
    const nodes = Array.from({ length: MAX_VIOLATIONS + 7 }, (_, i) => ({ target: [`#n${i}`] }));
    const out = flatten([{ id: "r", impact: "minor", help: "h", nodes }]);
    expect(out.violations).toHaveLength(MAX_VIOLATIONS);
    expect(out.omitted).toBe(7);
  });
});

describe("config a11y", () => {
  const base = { baseUrl: "http://localhost:3000", routes: [{ path: "/" }] };
  test("off unless set", () => {
    expect(parseConfig(base).a11y).toBe(false);
    expect(parseConfig({ ...base, a11y: true }).a11y).toBe(true);
  });
  test("must be a boolean", () => {
    expect(() => parseConfig({ ...base, a11y: "yes" })).toThrow(
      "config: a11y must be true or false",
    );
  });
});
