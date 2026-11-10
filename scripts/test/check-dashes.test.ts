import { describe, expect, test } from "vitest";
import { isExcepted, scanFiles, scanText } from "../check-dashes";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const files = (map: Record<string, string | Buffer>) => (path: string) =>
  path in map ? Buffer.from(map[path]!) : null;

describe("check-dashes", () => {
  test("a planted em dash fails, naming the file and line", () => {
    const hits = scanFiles(["docs/cli.md"], files({ "docs/cli.md": `ok\nbad ${EM} here\n` }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("docs/cli.md:2:");
    expect(hits[0]).toContain("U+2014");
  });

  test("an en dash in a range fails too", () => {
    const hits = scanText("a.ts", `// 0${EN}1\n`);
    expect(hits).toEqual([expect.stringContaining("a.ts:1: en dash (U+2013)")]);
  });

  test("a hyphen, a minus sign and a clean file pass", () => {
    expect(scanText("a.md", "a - b, 3−2, x-y\n")).toEqual([]);
  });

  test("an excepted path passes with a dash in it", () => {
    const paths = [
      "apps/web/worker-configuration.d.ts",
      "docs/capabilities/matrix.html",
      "apps/web/src/routeTree.gen.ts",
      "apps/web/drizzle/0001_x.sql",
      "bun.lock",
      "bench/corpus/a/head.png",
      "bench/fixtures-holdout/inbox.html",
      "bench/results/2026-01-01.json",
      "bench/argos-cache/x.json",
    ];
    const map = Object.fromEntries(paths.map((p) => [p, `x ${EM} y`]));
    for (const p of paths) expect(isExcepted(p)).toBe(true);
    expect(scanFiles(paths, files(map))).toEqual([]);
  });

  test("a source or docs path is not excepted", () => {
    for (const p of ["docs/cli.md", "AGENTS.md", "bench/src/holdout-cases.ts", "bench/PERF.md"])
      expect(isExcepted(p)).toBe(false);
  });

  test("a binary file and a file that is gone are skipped", () => {
    const binary = Buffer.concat([Buffer.from([0]), Buffer.from(EM)]);
    expect(scanFiles(["x.bin", "gone.md"], files({ "x.bin": binary }))).toEqual([]);
  });
});
