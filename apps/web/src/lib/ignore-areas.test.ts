import { describe, expect, test } from "vitest";
import type { IgnoreRect } from "#/db/schema";
import { ignoreAreas } from "./ignore-areas";

const uploaded: IgnoreRect = { x: 0, y: 0, width: 8, height: 8 };
const drawn: IgnoreRect = { x: 18, y: 8, width: 14, height: 14 };
const later: IgnoreRect = { x: 30, y: 30, width: 4, height: 4 };
const ui = { ...drawn, id: "b1", scope: "test" as const, by: "ada", at: 0 };

const measured = (ignored: IgnoreRect[]) => ({ ignored });

describe("the hatched areas are the ones the diff skipped (ob 1499)", () => {
  test("uploaded and drawn areas, each labelled with its source", () => {
    const areas = ignoreAreas(
      {
        ignore: [uploaded],
        diffResult: measured([uploaded, drawn]),
        resolvedDiff: { ignore: [ui] },
      },
      "config",
      null,
    );
    expect(areas).toEqual([
      { rect: uploaded, source: "config" },
      { rect: drawn, source: "UI" },
    ]);
  });

  test("an area on Main's shot is hatched too: the diff skipped it", () => {
    const areas = ignoreAreas(
      { ignore: [], diffResult: measured([uploaded]), resolvedDiff: null },
      "manifest",
      null,
    );
    expect(areas).toEqual([{ rect: uploaded, source: "manifest" }]);
  });

  test("a shot measured before a box was drawn shows no box; the one being placed shows", () => {
    const areas = ignoreAreas(
      { ignore: [], diffResult: measured([]), resolvedDiff: null },
      "config",
      later,
    );
    expect(areas).toEqual([{ rect: later, source: "UI" }]);
  });

  test("a shot nothing measured shows only its own uploaded areas", () => {
    const areas = ignoreAreas(
      { ignore: [uploaded], diffResult: null, resolvedDiff: { ignore: [ui] } },
      "config",
      null,
    );
    expect(areas).toEqual([{ rect: uploaded, source: "config" }]);
  });
});
