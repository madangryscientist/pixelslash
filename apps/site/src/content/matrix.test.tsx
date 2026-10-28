import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ComparePage } from "#/components/pages/compare";
import { ROWS, SUMMARY } from "./matrix.ts";

/*
 * The compare page against docs/capabilities/data.json as it is on disk, counted here the way
 * build.py counts it (a row is behind when our score is below the best competitor's), not through
 * matrix.ts. A change to either side that makes them disagree fails.
 */
type Raw = { k: string; ps: { v: string }; t: Record<string, string> };
const data: { rows: Raw[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../docs/capabilities/data.json"), "utf8"),
);
const SCORE: Record<string, number> = { y: 2, p: 1, n: 0, "?": 0 };
const score = (value: string): number => SCORE[value] ?? 0;
const behindKeys = data.rows
  .filter((row) => score(row.ps.v) < Math.max(...Object.values(row.t).map(score)))
  .map((row) => row.k);

describe("the compare page", () => {
  const html = renderToStaticMarkup(<ComparePage />);

  test("counts the rows and the behind rows data.json has", () => {
    expect(SUMMARY.rows).toBe(data.rows.length);
    expect(SUMMARY.behind).toBe(behindKeys.length);
    expect(SUMMARY.level).toBe(data.rows.length - behindKeys.length);
    expect(ROWS.filter((row) => row.behind).map((row) => row.key)).toEqual(behindKeys);
  });

  test("draws every row, and marks exactly the behind ones", () => {
    expect(html.match(/data-row=/g)).toHaveLength(data.rows.length);
    expect(html.match(/data-behind="1"/g) ?? []).toHaveLength(behindKeys.length);
    for (const key of behindKeys) expect(html).toContain(`data-behind-item="${key}"`);
  });

  test("lists every behind row in the behind section, none hidden", () => {
    expect(html.match(/data-behind-item=/g) ?? []).toHaveLength(behindKeys.length);
    expect(html).toContain(`Where we are behind (${behindKeys.length})`);
  });
});
