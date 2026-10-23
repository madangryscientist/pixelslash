import { describe, expect, test } from "vitest";
import { parseSummary, summaryInput } from "./summary";

/** The summary's prompt and the parse of its answer (ob 1668), with no build and no model. */

const row = (name: string, diffStatus: "changed" | "new" | "removed" | "unchanged" | null) => ({
  id: name,
  name,
  viewport: "1280x720",
  theme: "light",
  diffStatus,
  rebaselineNeeded: false,
  diffResult: null,
  aiReview: null,
  aiPending: false,
  aiError: null,
});

describe("summaryInput and parseSummary", () => {
  test("refs are per story and group, and nothing describable means no refs", () => {
    const input = summaryInput([
      row("a@theme=x", "changed"),
      row("a@theme=y", "changed"),
      row("a@theme=z", "unchanged"),
      row("b", "new"),
      row("c", null),
    ]);
    expect([...input.refs]).toEqual([
      ["C1", ["a@theme=x", "a@theme=y"]],
      ["N1", ["b"]],
    ]);
    expect(input.prompt).toMatch(/\[C1\] .*: 2 of its 3 variants/);
    expect(summaryInput([row("a", "unchanged"), row("c", null)]).describable).toBe(false);
  });

  test("unknown refs, ref-less lines and long answers are cut", () => {
    const refs = new Map([
      ["C1", ["s1", "s2"]],
      ["N1", ["s3"]],
    ]);
    const long = "x".repeat(400);
    const parsed = parseSummary(
      `Intro with no ref.\nBoth changed. [C1] [C1]\nMade up. [C9]\n${long} [N1]\n${"More. [N1]\n".repeat(9)}`,
      refs,
    );
    expect(parsed[0]).toEqual({ text: "Both changed.", shots: ["s1", "s2"] });
    expect(parsed[1]?.text).toHaveLength(300);
    expect(parsed).toHaveLength(6);
    expect(() => parseSummary("Nothing to see. [C9]", refs)).toThrow(/named none/);
  });
});
