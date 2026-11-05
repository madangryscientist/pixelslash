import { describe, expect, test } from "vitest";
import { buildSearchIndex } from "./search-index.ts";
import { type SearchEntry, search } from "./search.ts";

const INDEX = buildSearchIndex();

describe("the docs search index", () => {
  test("holds every docs page and the self-host guide", () => {
    const urls = new Set(INDEX.map((entry) => entry.url.split("#")[0]));
    expect(urls.has("/self-host")).toBe(true);
    expect(urls.has("/docs/troubleshooting")).toBe(true);
    expect(urls.has("/docs/cli")).toBe(true);
    expect(urls.has("/docs/upload-flaky")).toBe(true);
  });

  test("is one small static file: no entry is empty, and the whole is under 600 KB", () => {
    for (const entry of INDEX) expect(entry.heading).not.toBe("");
    expect(JSON.stringify(INDEX).length).toBeLessThan(600_000);
  });

  test("carries no ticket id", () => {
    expect(JSON.stringify(INDEX)).not.toMatch(/\b(?:PS|OB)-\d+\b/);
  });
});

describe("search", () => {
  test("an exact error string from the troubleshooting page finds its entry first", () => {
    const found = [
      'has no "entries": needs Storybook 7 or later',
      "no token given",
      "upload incomplete",
      "rebaseline_needed",
      "do not go with --upload",
      "upload incomplete: <n>/<m> shots sent",
      "upload incomplete: 0/1 shots sent",
    ].map((message) => [message, search(INDEX, message)[0]?.entry.url.split("#")[0]]);
    expect(found.filter(([, page]) => page !== "/docs/troubleshooting")).toEqual([]);
  });

  test("finds a command and the page that owns it", () => {
    const urls = search(INDEX, "pixelslash flake").map((hit) => hit.entry.url);
    expect(urls.some((url) => url.startsWith("/docs/upload-flaky"))).toBe(true);
  });

  test("finds the self-host guide", () => {
    const urls = search(INDEX, "self-host").map((hit) => hit.entry.url);
    expect(urls.some((url) => url.startsWith("/self-host"))).toBe(true);
  });

  test("needs every word; an empty or unmatched query finds nothing", () => {
    const entries: SearchEntry[] = [
      { url: "/a", page: "A", heading: "Alpha", text: "one two" },
      { url: "/b", page: "B", heading: "Beta", text: "two three" },
    ];
    expect(search(entries, "two").map((hit) => hit.entry.url)).toEqual(["/a", "/b"]);
    expect(search(entries, "one three")).toEqual([]);
    expect(search(entries, "   ")).toEqual([]);
    expect(search(entries, "zzz")).toEqual([]);
  });

  test("a heading match outranks a body match, and a hit carries a snippet", () => {
    const entries: SearchEntry[] = [
      {
        url: "/body",
        page: "P",
        heading: "Other",
        text: "the baseline is the shot you compare to",
      },
      { url: "/head", page: "P", heading: "Baseline", text: "something else" },
    ];
    const hits = search(entries, "baseline");
    expect(hits[0]?.entry.url).toBe("/head");
    expect(hits[1]?.snippet).toContain("baseline");
  });
});
