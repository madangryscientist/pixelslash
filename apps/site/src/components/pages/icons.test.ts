import { describe, expect, test } from "vitest";
import { FEATURES } from "#/components/pages/home";
import { FACTS } from "#/content/pricing";

/*
 * A card on a page carries an icon that says what the feature is, so two cards on one page never
 * share one. The rule is per page: the same icon may appear on home and on pricing.
 */
const ICONS = new Set([
  "diff",
  "baseline",
  "review",
  "ci",
  "self-host",
  "privacy",
  "capture",
  "branch",
  "theme",
  "speed",
]);

const duplicates = (names: readonly string[]): string[] =>
  names.filter((name, index) => names.indexOf(name) !== index);

describe("the card icons", () => {
  test("home: no two feature cards share an icon", () => {
    const names = FEATURES.map((feature) => feature.icon);
    expect(duplicates(names)).toEqual([]);
  });

  test("pricing: no two fact cards share an icon", () => {
    const names = FACTS.map((fact) => fact.icon);
    expect(duplicates(names)).toEqual([]);
  });

  test("every icon on both pages is one of the ten the set draws", () => {
    for (const name of [...FEATURES, ...FACTS].map((card) => card.icon)) {
      expect(ICONS.has(name)).toBe(true);
    }
  });

  test("the judge card shows the eye, and the server card the server stack", () => {
    expect(FEATURES.find((feature) => feature.title === "A design-system judge")?.icon).toBe(
      "review",
    );
    expect(FEATURES.find((feature) => feature.title === "A review server")?.icon).toBe("self-host");
    expect(FACTS.find((fact) => fact.title.startsWith("Paid hosting"))?.icon).toBe("speed");
  });
});
