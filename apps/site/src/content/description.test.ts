import { describe, expect, test } from "vitest";
import { descriptionFrom } from "./docs.ts";

describe("a page's description", () => {
  test("a paragraph that leads into a code block does not end on its colon", () => {
    expect(descriptionFrom("Check which shots have a twin:")).toBe(
      "Check which shots have a twin.",
    );
  });

  test("a long paragraph is cut at a sentence when one ends far enough in", () => {
    const first = "A first sentence that is long enough to stand as the whole description here.";
    expect(descriptionFrom(`${first} ${"More words follow. ".repeat(12)}`)).toMatch(/\.$/);
    expect(descriptionFrom(`${first} ${"word ".repeat(40)}`)).toBe(first);
  });

  test("with no sentence to cut at, it stops at a word and says so", () => {
    const cut = descriptionFrom("word ".repeat(60));
    expect(cut.length).toBeLessThanOrEqual(155);
    expect(cut).toMatch(/word…$/);
  });
});
