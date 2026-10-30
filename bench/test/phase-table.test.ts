import { describe, expect, test } from "vitest";
import { phaseTable, type ImplMeasured } from "../src/perf/impl.ts";
import { phaseCell } from "./phase-cell.ts";

/** One implementation's measured `diff-phone` step, with the given wall and phases. */
function measuredRow(
  command: string,
  wall: number,
  phases: Record<string, number[]>,
): ImplMeasured {
  const samples = { decode: [4], diff: [3], wall: [wall], startup: [], rest: [], phases, rss: [] };
  return { command, steps: new Map([["diff-phone", { samples, failure: null }]]) };
}

describe("phaseTable", () => {
  test("the pixel_compare cell does not depend on the wall value in the same row", () => {
    for (const wall of [1.5, 11.5]) {
      const table = phaseTable(
        [measuredRow("phased", wall, { pixel_compare: [1.5] }), measuredRow("bare", wall, {})],
        ["diff-phone"],
      );
      const [header, , second] = table.split("\n").slice(1);
      expect(phaseCell(header ?? "", second ?? "", "wall")).toBe(wall.toFixed(1));
      expect(phaseCell(header ?? "", second ?? "", "pixel_compare")).toBe("-");
    }
  });
});
