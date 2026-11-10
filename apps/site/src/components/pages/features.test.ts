import { describe, expect, test } from "vitest";
import { FEATURES } from "#/components/pages/home";

/*
 * The home cards are read by people, not parsed by a tool, so each body is plain prose: at most 25
 * words, a sentence that opens on an ordinary word (not a flag or a command), and no figures. The
 * figures and the rival names live on the pages the cards link to.
 */
describe("home feature cards", () => {
  test.each(FEATURES.map((feature) => [feature.title, feature.body] as const))(
    "%s is plain words",
    (_title, body) => {
      const words = body.trim().split(/\s+/);
      expect(words.length).toBeLessThanOrEqual(25);
      expect(body).toMatch(/^[A-Za-z]/);
      expect(body.toLowerCase().startsWith("pixelslash")).toBe(false);
      expect(body).not.toMatch(/\d/);
      expect(body).not.toMatch(/chromatic|percy|argos/i);
    },
  );
});
