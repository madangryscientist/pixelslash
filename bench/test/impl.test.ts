import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseImplOutput } from "../src/impl/contract.ts";
import { runImplCorpus } from "../src/impl/corpus.ts";
import { describeFailure, invokeImpl, splitCommand } from "../src/impl/invoke.ts";
import { parseArgs } from "../src/perf/args.ts";
import { implFailures, implTable, measureImpls, phaseTable } from "../src/perf/impl.ts";
import { loadCorpus } from "../src/corpus.ts";
import { branchFile, mainFile, writeFixtures } from "../src/perf/fixtures.ts";
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

  test("phases and startup_ms are optional: an output with them and one without both conform (ob 1932)", () => {
    const phased = { ...OK, startup_ms: 12.5, phases: { pixel_compare: 1.5, regions: 0 } };
    expect(parseImplOutput(JSON.stringify(phased))).toEqual(phased);
    const bare = parseImplOutput(JSON.stringify(OK));
    expect("phases" in bare || "startup_ms" in bare).toBe(false);
    expect(parseImplOutput(JSON.stringify({ ...OK, phases: {} })).phases).toEqual({});
  });

  test("a bad phase or startup_ms is named", () => {
    expect(badInput({ phases: [] })).toThrow("phases must be an object");
    expect(badInput({ phases: "x" })).toThrow("phases must be an object");
    expect(badInput({ phases: { regions: -1 } })).toThrow("phases.regions must be a number >= 0");
    expect(badInput({ phases: { regions: "1" } })).toThrow("phases.regions");
    expect(badInput({ startup_ms: -3 })).toThrow("startup_ms");
    expect(badInput({ startup_ms: "3" })).toThrow("startup_ms");
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

  test("the spawn stamp and --decode reach the implementation (ob 1932)", async () => {
    const echo = fake(
      "stamp",
      `const at = Number(process.env.PS_BENCH_SPAWN_AT);
       const mode = process.argv.slice(2).join(" ");
       process.stdout.write(JSON.stringify({ verdict: "changed", regions: [{ x: 1, y: 1, w: 1, h: 1 }], decode_ms: 0, diff_ms: 0, startup_ms: Date.now() - at, phases: { [mode]: 1 } }));`,
    );
    const r = await invokeImpl(echo, "a", "b", { decode: "parallel" });
    expect(r.ok && Object.keys(r.output.phases ?? {})).toEqual([
      "diff a b --json --decode parallel",
    ]);
    expect(r.ok && r.output.startup_ms).toBeGreaterThan(0);
    expect(r.ok && r.output.startup_ms).toBeLessThan(5_000);
    const plain = await invokeImpl(echo, "a", "b", {});
    expect(plain.ok && Object.keys(plain.output.phases ?? {})).toEqual(["diff a b --json"]);
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

const stripped = (r: Awaited<ReturnType<typeof invokeImpl>>) =>
  JSON.stringify(r.ok ? { verdict: r.output.verdict, regions: r.output.regions } : r.failure);

const badInput = (extra: object) => () => parseImplOutput(JSON.stringify({ ...OK, ...extra }));

const sumOf = (phases: Record<string, number>, names: string[]): number =>
  names.reduce((t, n) => t + (phases[n] ?? Number.NaN), 0);
const DIFF_PHASES = ["pixel_compare", "anti_alias", "regions", "overlay_encode"];
const DECODE_PHASES = ["decode_read", "decode_inflate", "decode_unfilter", "decode_other"];

/** `ts-diff.ts` on the desktop fixture pair in one decode mode. */
async function desktop(decode: "parallel" | "sequential") {
  const fixtures = join(dir, "fixtures-phases");
  writeFixtures(fixtures);
  const r = await invokeImpl(
    TS_DIFF,
    join(fixtures, mainFile("diff-desktop")),
    join(fixtures, branchFile("diff-desktop")),
    { decode },
  );
  if (!r.ok) throw new Error(describeFailure(r.failure));
  return r.output;
}

describe("ts-diff --decode (ob 1932)", () => {
  test("parallel gives the verdict and regions sequential does, on both corpora", async () => {
    const cases = [...loadCorpus("main"), ...loadCorpus("holdout")];
    expect(cases.length).toBeGreaterThan(100);
    const mismatches: string[] = [];
    for (let i = 0; i < cases.length; i += 8) {
      await Promise.all(
        cases.slice(i, i + 8).map(async (c) => {
          const [b, h] = [join(c.dir, "base.png"), join(c.dir, "head.png")];
          const [seq, par] = await Promise.all([
            invokeImpl(TS_DIFF, b, h, { decode: "sequential" }),
            invokeImpl(TS_DIFF, b, h, { decode: "parallel" }),
          ]);
          if (!seq.ok) mismatches.push(`${c.corpus}/${c.name}: sequential failed`);
          else if (stripped(seq) !== stripped(par)) mismatches.push(`${c.corpus}/${c.name}`);
        }),
      );
    }
    expect(mismatches).toEqual([]);
  }, 180_000);

  test("sequential: the diff phases and the decode split add up to diff_ms and decode_ms", async () => {
    const { phases = {}, decode_ms, diff_ms, startup_ms } = await desktop("sequential");
    expect(Object.values(phases).every((v) => v >= 0)).toBe(true);
    expect(startup_ms).toBeGreaterThan(0);
    expect(Math.abs(sumOf(phases, DIFF_PHASES) - diff_ms)).toBeLessThanOrEqual(
      Math.max(2, diff_ms * 0.1),
    );
    expect(Math.abs(sumOf(phases, DECODE_PHASES) - decode_ms)).toBeLessThanOrEqual(
      Math.max(2, decode_ms * 0.1),
    );
  });

  test("parallel: the decode split is summed work over both files", async () => {
    const { phases = {}, diff_ms } = await desktop("parallel");
    expect(Math.abs(sumOf(phases, DIFF_PHASES) - diff_ms)).toBeLessThanOrEqual(
      Math.max(2, diff_ms * 0.1),
    );
    expect(sumOf(phases, DECODE_PHASES)).toBeGreaterThan(0);
  });

  test("a bad --decode is a usage error", async () => {
    const proc = Bun.spawn(
      [...TS_DIFF.split(" "), "diff", "a.png", "b.png", "--json", "--decode", "both"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(2);
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

  test("--decode is parallel or sequential, and applies to --impl only", () => {
    expect(parseArgs(["--impl", "x"]).decode).toBeNull();
    expect(parseArgs(["--impl", "x", "--decode", "parallel"]).decode).toBe("parallel");
    expect(parseArgs(["--decode", "sequential", "--impl", "x"]).decode).toBe("sequential");
    expect(() => parseArgs(["--impl", "x", "--decode", "both"])).toThrow("parallel or sequential");
    expect(() => parseArgs(["--decode", "parallel"])).toThrow("--impl only");
  });

  test("the phase table shows a dash where an implementation reports none, and the dump carries the phases", async () => {
    const fixtures = join(dir, "fixtures");
    writeFixtures(fixtures);
    const phased = fake(
      "phased",
      `process.stdout.write(JSON.stringify({ verdict: "changed", regions: [{ x: 0, y: 0, w: 1, h: 1 }], decode_ms: 4, diff_ms: 3, startup_ms: 5, phases: { decode_inflate: 2, pixel_compare: 1.5, regions: 1, overlay_encode: 0.5 } }));`,
    );
    const measured = await measureImpls([phased, good], ["diff-phone"], {
      fixtures,
      rounds: 1,
      timeoutMs: 30_000,
      decode: "sequential",
    });
    const table = phaseTable(measured, ["diff-phone"]);
    const [header, first, second] = table.split("\n").slice(1);
    for (const col of [
      "decode_inflate",
      "pixel_compare",
      "regions",
      "overlay_encode",
      "startup",
      "rest",
      "wall",
    ])
      expect(header).toContain(col);
    expect(first).toContain("2.0");
    expect(first).toContain("1.5");
    expect(second).toContain("-");
    expect(second).not.toContain("1.5");
    const [step, plain] = measured.map((m) => m.steps.get("diff-phone")?.samples);
    expect(step?.phases["pixel_compare"]).toEqual([1.5]);
    expect(step?.startup).toEqual([5]);
    expect(step?.rest[0]).toBeCloseTo((step?.wall[0] ?? 0) - 5 - 4 - 3, 6);
    expect(plain?.startup).toEqual([]);
    expect(phaseTable(measured.slice(1), ["diff-phone"])).toBe("");
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
