import { describe, expect, test } from "vitest";
import { unmatchedTally } from "../src/unmatched.ts";

describe("unmatchedTally (PS-241)", () => {
  test("a selector that matched every shot says nothing; a flush clears the tally, so a second flush is silent", () => {
    const lines: string[] = [];
    const tally = unmatchedTally((m) => lines.push(m));
    tally.checked("mask", [".ad"]);
    tally.checked("mask", [".ad"]);
    tally.flush();
    expect(lines).toEqual([]);
    tally.checked("ignore", [".a"])(".a");
    tally.flush();
    tally.flush();
    expect(lines).toEqual(['warning: ignore ".a" matched no shot in this run']);
  });
});
