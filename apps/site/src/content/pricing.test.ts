import { describe, expect, test } from "vitest";
import { FACTS, LICENCE_BRIEF } from "#/content/pricing";

const FIRST =
  "PixelSlash is licensed under the Elastic License 2.0, which is source available, not open source.";
const BRIEF =
  "The CLI, the diff engine and the review app are all in the repository, with nothing held back. You may use, copy and modify it. You may not offer it to others as a hosted or managed service that gives them a substantial set of its features.";

describe("the licence copy (PS-386)", () => {
  test("the licence card keeps only its first sentence", () => {
    expect(FACTS).toHaveLength(3);
    expect(FACTS[0].body).toBe(FIRST);
  });

  test("the callout holds the other three sentences word for word, in order", () => {
    expect(LICENCE_BRIEF).toBe(BRIEF);
  });

  test("no sentence of the brief is left in a card", () => {
    for (const sentence of BRIEF.split(/(?<=\.) /)) {
      expect(FACTS.filter((fact) => fact.body.includes(sentence))).toEqual([]);
    }
  });
});
