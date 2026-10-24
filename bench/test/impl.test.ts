import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseImplOutput } from "../src/impl/contract.ts";
import { runImplCorpus } from "../src/impl/corpus.ts";
import { describeFailure, invokeImpl, splitCommand } from "../src/impl/invoke.ts";
import { parseArgs } from "../src/perf/args.ts";
import { implFailures, implTable, measureImpls } from "../src/perf/impl.ts";
import { loadCorpus } from "../src/corpus.ts";
import { writeFixtures } from "../src/perf/fixtures.ts";
import { runPixelslash } from "../src/pixelslash.ts";

const dir = mkdtempSync(join(tmpdir(), "ps-impl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A one-file implementation: `body` runs with `process.argv.slice(3)` = [base, head, "--json"]. */
function fake(name: string, body: string): string {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, body);
  return `bun ${file}`;
}

const OK = { verdict: "changed", regions: [{ x: 1, y: 2, w: 3, h: 4 }], decode_ms: 1, diff_ms: 2 };
const good = fake("good", `process.stdout.write(${JSON.stringify(JSON.stringify(OK))});`);
const TS_DIFF = "bun src/impl/ts-diff.ts";

describe("parseImplOutput", () => {
  test("reads the contract and ignores fields it does not know", () => {
    expect(parseImplOutput(`${JSON.stringify({ ...OK, extra: 1 })}\n`)).toEqual(OK);
  });

  test("names what is wrong", () => {
    expect(() => parseImplOutput("")).toThrow("not JSON: (empty)");
    expect(() => parseImplOutput("oops")).toThrow("not JSON");
    expect(() => parseImplOutput("[]")).toThrow("not a JSON object");
    expect(() => parseImplOutput(JSON.stringify({ ...OK, verdict: "yes" }))).toThrow("verdict");
    expect(() => parseImplOutput(JSON.stringify({ ...OK, regions: {} }))).toThrow("regions");
    expect(() => parseImplOutput(JSON.stringify({ ...OK, decode_ms: "1" }))).toThrow("decode_ms");
    expect(() => parseImplOutput(JSON.stringify({ ...OK, diff_ms: -1 }))).toThrow("diff_ms");
    expect(() =>
      parseImplOutput(JSON.stringify({ ...OK, regions: [{ x: 0, y: 0, w: 0, h: 1 }] })),
    ).toThrow("regions[0]");
    expect(() =>
      parseImplOutput(JSON.stringify({ ...OK, regions: [{ x: 0.5, y: 0, w: 1, h: 1 }] })),
    ).toThrow("regions[0]");
  });
});

describe("invokeImpl", () => {
  const base = join(dir, "base.png");
  const run = (command: string, timeoutMs?: number) =>
    invokeImpl(command, base, base, timeoutMs === undefined ? {} : { timeoutMs });

  test("a good implementation answers, and wall time is measured", async () => {
    const r = await run(good);
    expect(r.ok && r.output).toEqual(OK);
    expect(r.wallMs).toBeGreaterThan(0);
  });

  test("it is called as <impl> diff <base> <head> --json", async () => {
    const echo = fake(
      "echo",
      `const [verb, a, b, flag] = process.argv.slice(2);
       process.stdout.write(JSON.stringify({ verdict: verb === "diff" && flag === "--json" ? "changed" : "unchanged", regions: [{ x: a.length, y: b.length, w: 1, h: 1 }], decode_ms: 0, diff_ms: 0 }));`,
    );
    const r = await invokeImpl(echo, "aa", "bbb", {});
    expect(r.ok && r.output.verdict).toBe("changed");
    expect(r.ok && r.output.regions[0]).toEqual({ x: 2, y: 3, w: 1, h: 1 });
  });

  test("bad JSON, a non-zero exit, a timeout and a missing command are named failures", async () => {
    const bad = await run(fake("bad", `process.stdout.write("not json");`));
    expect(!bad.ok && describeFailure(bad.failure)).toContain("bad output: stdout is not JSON");

    const exit = await run(
      fake("exit", `process.stderr.write("cannot decode\\nmore\\n"); process.exit(3);`),
    );
    expect(!exit.ok && describeFailure(exit.failure)).toBe("exit 3: cannot decode");

    const slow = await run(fake("slow", `await Bun.sleep(30_000);`), 300);
    expect(!slow.ok && describeFailure(slow.failure)).toBe("timeout after 300 ms");
    expect(slow.wallMs).toBeLessThan(5_000);

    const missing = await run(join(dir, "no-such-binary"));
    expect(!missing.ok && missing.failure.kind).toBe("start");
  });

  test("an empty command is refused, and a command may carry arguments", () => {
    expect(() => splitCommand("  ")).toThrow("needs a command");
    expect(splitCommand("./pxdiff --fast")).toEqual(["./pxdiff", "--fast"]);
  });
});

describe("runImplCorpus", () => {
  const cases = loadCorpus("main").slice(0, 4);

  test("the TS reference scores the same as the in-process engine", async () => {
    const { results, failures } = await runImplCorpus(TS_DIFF, cases);
    expect(failures).toEqual([]);
    const inProcess = runPixelslash(cases);
    for (const [key, r] of inProcess) {
      const out = results.get(key);
      expect({ key, changed: out?.changed, regions: out?.regions }).toEqual({
        key,
        changed: r.changed,
        regions: r.regions,
      });
    }
  });

  test("a broken implementation fails every case by name and the run goes on", async () => {
    const { results, failures } = await runImplCorpus(
      fake("alwaysbad", `process.stdout.write("{}");`),
      cases,
    );
    expect(results.size).toBe(0);
    expect(failures.map((f) => f.key)).toEqual(cases.map((c) => `main/${c.name}`));
  });
});

describe("bench:perf --impl", () => {
  test("flags: implementations repeat, refs do not mix with them, only the diff steps apply", () => {
    const a = parseArgs(["--impl", "x y", "--impl", "z"]);
    expect(a.impls).toEqual(["x y", "z"]);
    expect(a.only).toEqual(["diff-phone", "diff-desktop", "diff-long"]);
    expect(parseArgs(["--impl", "x", "--only", "diff-long"]).only).toEqual(["diff-long"]);
    expect(() => parseArgs(["--impl", "x", "--base", "main"])).toThrow("compare refs");
    expect(() => parseArgs(["--impl", "x", "--check"])).toThrow("compare refs");
    expect(() => parseArgs(["--impl", "x", "--only", "capture"])).toThrow("diff steps only");
    expect(() => parseArgs(["--impl"])).toThrow("needs a value");
  });

  test("a failing implementation is reported per step and the others are still timed", async () => {
    const fixtures = join(dir, "fixtures");
    writeFixtures(fixtures);
    const broken = fake("perfbad", `process.exit(7);`);
    const measured = await measureImpls([TS_DIFF, broken], ["diff-phone"], {
      fixtures,
      rounds: 2,
      timeoutMs: 30_000,
    });
    expect(measured[0]?.steps.get("diff-phone")?.samples.diff).toHaveLength(2);
    expect(implFailures(measured)).toEqual([`#2 ${broken} on diff-phone: exit 7`]);
    expect(implTable(measured, ["diff-phone"])).toContain("FAILED: exit 7");
  });

  test("an implementation that calls a differing pair unchanged fails", async () => {
    const fixtures = join(dir, "fixtures");
    const lazy = fake(
      "lazy",
      `process.stdout.write(JSON.stringify({ verdict: "unchanged", regions: [], decode_ms: 0, diff_ms: 0 }));`,
    );
    const measured = await measureImpls([lazy], ["diff-phone"], {
      fixtures,
      rounds: 1,
      timeoutMs: 30_000,
    });
    expect(implFailures(measured)[0]).toContain("said unchanged on a pair that differs");
  });
});
