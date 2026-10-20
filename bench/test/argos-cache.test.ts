import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  ARGOS_THRESHOLD,
  CACHE_FILE,
  cacheKey,
  cacheText,
  entryResult,
  loadCache,
  pairHash,
  parseCache,
  pinnedArgosCommit,
  type ArgosCache,
} from "../src/argos-cache.ts";
import { caseKey, loadCorpora } from "../src/corpus.ts";
import { readFileSync } from "node:fs";

const bytes = (s: string) => Buffer.from(s);

describe("pairHash", () => {
  test("the same two shots hash the same, and a changed shot does not", () => {
    expect(pairHash(bytes("a"), bytes("b"))).toBe(pairHash(bytes("a"), bytes("b")));
    expect(pairHash(bytes("a"), bytes("c"))).not.toBe(pairHash(bytes("a"), bytes("b")));
  });

  test("base and head are not interchangeable, and their boundary cannot blur", () => {
    expect(pairHash(bytes("a"), bytes("b"))).not.toBe(pairHash(bytes("b"), bytes("a")));
    expect(pairHash(bytes("ab"), bytes("c"))).not.toBe(pairHash(bytes("a"), bytes("bc")));
  });
});

describe("cacheKey", () => {
  test("a different Argos commit or threshold is a different key", () => {
    const k = cacheKey("h", "c1", 0.5);
    expect(cacheKey("h", "c2", 0.5)).not.toBe(k);
    expect(cacheKey("h", "c1", 0.2)).not.toBe(k);
    expect(cacheKey("g", "c1", 0.5)).not.toBe(k);
  });
});

describe("pinnedArgosCommit", () => {
  test("reads the commit the Dockerfile pins", () => {
    const sha = "21e8520c28129d501b22028a5499546b03336e38";
    expect(pinnedArgosCommit(`FROM x\nARG ARGOS_COMMIT=${sha}\nARG TSX=1\n`)).toBe(sha);
  });

  test("refuses a Dockerfile with no pin", () => {
    expect(() => pinnedArgosCommit("FROM x\n")).toThrow(/ARGOS_COMMIT/);
  });

  test("the repo's own Dockerfile pins one", () => {
    expect(pinnedArgosCommit()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the cache file", () => {
  const cache: ArgosCache = {
    version: 1,
    entries: {
      b: { label: "main/b", changed: false, score: 0, ms: null, regions: [], diff: false },
      a: {
        label: "main/a",
        changed: true,
        score: 0.0074,
        ms: 12.5,
        regions: [{ x: 1, y: 2, w: 3, h: 4 }],
        diff: false,
      },
    },
  };

  test("round-trips, with sorted keys so a refresh diffs line by line", () => {
    const text = cacheText(cache);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(parseCache(text)).toEqual({
      version: 1,
      entries: { a: cache.entries["a"], b: cache.entries["b"] },
    });
  });

  test("a cached entry answers like the live run: verdict, regions, rounded score", () => {
    const a = cache.entries["a"];
    if (!a) throw new Error("fixture");
    const r = entryResult("hash:commit:0.5", a);
    expect(r).toMatchObject({ changed: true, ms: 12.5, note: "score 0.0074", diffPng: null });
    expect(r.regions).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
  });

  test("a file that is not a version 1 cache is refused", () => {
    expect(() => parseCache('{"version":2,"entries":{}}')).toThrow(/version 1/);
  });

  test("a missing file is an empty cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-cache-test-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    expect(loadCache(join(dir, "none.json")).entries).toEqual({});
    writeFileSync(join(dir, "c.json"), cacheText(cache));
    expect(Object.keys(loadCache(join(dir, "c.json")).entries)).toEqual(["a", "b"]);
  });
});

describe("the committed cache", () => {
  test("has an Argos verdict for every case of both corpora, so `bun run bench` needs no VM", () => {
    const commit = pinnedArgosCommit();
    const cache = loadCache(CACHE_FILE);
    const missing = loadCorpora()
      .filter((c) => {
        const hash = pairHash(
          readFileSync(join(c.dir, "base.png")),
          readFileSync(join(c.dir, "head.png")),
        );
        return !cache.entries[cacheKey(hash, commit, ARGOS_THRESHOLD)];
      })
      .map(caseKey);
    expect(missing, "run `bun run bench -- --refresh-argos` with VM 101 up").toEqual([]);
  });
});
