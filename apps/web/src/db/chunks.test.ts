import { describe, expect, test } from "vitest";
import { MAX_PARAMS, chunk, inChunks } from "./chunks";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

describe("chunk (ob 1773)", () => {
  test("a list that fits stays one part", () => {
    expect(chunk(ids(MAX_PARAMS), 0)).toEqual([ids(MAX_PARAMS)]);
  });

  test("the statement's other parameters shrink each part", () => {
    const parts = chunk(ids(250), 3);
    expect(parts.map((p) => p.length)).toEqual([97, 97, 56]);
    expect(parts.flat()).toEqual(ids(250));
  });

  test("an item binding several parameters counts each", () => {
    expect(chunk(ids(120), 4, 2).map((p) => p.length)).toEqual([48, 48, 24]);
  });

  test("no part binds more than the limit", () => {
    for (const other of [0, 1, 6, 99])
      for (const part of chunk(ids(500), other, 1))
        expect(part.length + other).toBeLessThanOrEqual(MAX_PARAMS);
  });

  test("duplicates are dropped, first place kept", () => {
    expect(chunk(["a", "b", "a", "c", "b"], 98)).toEqual([["a", "b"], ["c"]]);
  });

  test("an empty list is no part, so no statement", () => {
    expect(chunk([], 0)).toEqual([]);
  });

  test("a statement whose other parameters leave no room is refused", () => {
    expect(() => chunk(ids(1), MAX_PARAMS)).toThrow(/cannot fit/);
    expect(() => chunk(ids(1), 99, 2)).toThrow(/cannot fit/);
  });
});

describe("inChunks", () => {
  test("reads each part in order and merges the rows", async () => {
    const seen: number[] = [];
    const rows = await inChunks(ids(150), 10, async (part) => {
      seen.push(part.length);
      return part.map((id) => id.toUpperCase());
    });
    expect(seen).toEqual([90, 60]);
    expect(rows).toEqual(ids(150).map((id) => id.toUpperCase()));
  });

  test("an empty list never reads", async () => {
    let reads = 0;
    expect(await inChunks([], 0, async () => [++reads])).toEqual([]);
    expect(reads).toBe(0);
  });
});
