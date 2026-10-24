#!/usr/bin/env bun
/**
 * `bun run bench:perf` / `bun run bench:perf:check` (ob 1790): how fast is this tree against a base,
 * measured back to back on this machine.
 *
 *   bun bench/src/perf/run.ts [--check] [--base <ref>] [--runs <n>] [--only <step,...>]
 *   bun bench/src/perf/run.ts --impl <cmd> [--impl <cmd> ...] [--runs <n>] [--only <step,...>]
 *
 * The base (`--base`, else `origin/main`, else `main`) is checked out into a temporary git worktree,
 * and the base and this tree take turns (A B A B ...) for `--runs` rounds, so drift and background
 * load land on both. Nothing is compared against an earlier run, and nothing is committed: the
 * run's numbers go to bench/perf-results/, which git ignores. On demand only: never in
 * `bun run test`, the gate or a land. With `--impl` (ob 1909) it times outside implementations of the
 * diff contract (bench/README.md) against each other instead of two refs; see ./impl.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type Args } from "./args.ts";
import { writeFixtures } from "./fixtures.ts";
import { implDump, implFailures, implTable, measureImpls, phaseTable } from "./impl.ts";
import { say, warn } from "../say.ts";
import { compare, regressionLine, summarise, type Comparison, type Summary } from "./stats.ts";
import { buildWeb, freePort } from "./step-build.ts";
import { parseProbe, STEP_LABELS, type ProbeResult, type StepId } from "./steps.ts";
import {
  CACHE_ROOT,
  addBaseWorktree,
  pickBase,
  removeWorktree,
  resolveRef,
  run,
  running,
  sweepStale,
} from "./worktree.ts";

const HEAD_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RESULTS_DIR = join(HEAD_ROOT, "bench/perf-results");

type Samples = Map<StepId, number[]>;
type Tree = { name: "base" | "head"; root: string };

/** What to undo on the way out, newest first; run by the `finally` and by SIGINT / SIGTERM. */
const cleanups: (() => Promise<void> | void)[] = [];
let cleaning: Promise<void> | null = null;

/** One pass, shared: a signal and the `finally` both ask, and neither may exit while the other works. */
function cleanup(): Promise<void> {
  cleaning ??= undo();
  return cleaning;
}

async function undo(): Promise<void> {
  if (running.size > 0) {
    for (const proc of running) proc.kill("SIGTERM");
    // A probe in the middle of a synchronous diff answers late; do not wait on it forever.
    const killer = setTimeout(() => {
      for (const proc of running) proc.kill("SIGKILL");
    }, 10_000);
    await Promise.all([...running].map((proc) => proc.exited));
    clearTimeout(killer);
  }
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()?.();
    } catch (e) {
      warn(`cleanup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

async function probe(
  tree: string,
  args: { fixtures: string; stubPort: number; tmp: string; steps: StepId[]; slowDiffMs?: string },
): Promise<ProbeResult> {
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: args.tmp };
  // The slow-diff hook is for showing the check can fail: it slows the head tree alone.
  delete env["PIXELSLASH_PERF_SLOW_DIFF_MS"];
  if (args.slowDiffMs) env["PIXELSLASH_PERF_SLOW_DIFF_MS"] = args.slowDiffMs;
  const proc = Bun.spawn(
    [
      "bun",
      join(tree, "bench/src/perf/probe.ts"),
      "--fixtures",
      args.fixtures,
      "--stub-port",
      String(args.stubPort),
      "--steps",
      args.steps.join(","),
    ],
    { cwd: tree, env, stdout: "pipe", stderr: "inherit" },
  );
  running.add(proc);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  running.delete(proc);
  if (code !== 0) throw new Error(`probe in ${tree} exited ${code}`);
  return parseProbe(out.trim().split("\n").at(-1) ?? "");
}

const ms = (n: number) => n.toFixed(1).padStart(9);

/** `rows[i]` is the comparison of `steps[i]`; no rows means head alone. */
function table(rows: Comparison[] | null, head: Summary[], steps: StepId[]): string {
  const lines: string[] = [];
  if (rows === null) {
    lines.push(`${"step".padEnd(40)} ${"median".padStart(9)} ${"p95".padStart(9)}   n`);
    steps.forEach((s, i) => {
      const h = head[i];
      if (h)
        lines.push(
          `${STEP_LABELS[s].padEnd(40)} ${ms(h.median)} ${ms(h.p95)} ${String(h.n).padStart(3)}`,
        );
    });
    return lines.join("\n");
  }
  lines.push(
    `${"step (ms)".padEnd(40)} ${"base med".padStart(9)} ${"head med".padStart(9)} ${"change".padStart(8)} ${"base p95".padStart(9)} ${"head p95".padStart(9)}`,
  );
  steps.forEach((s, i) => {
    const c = rows[i];
    if (!c) return;
    const change = `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(1)}%`.padStart(8);
    lines.push(
      `${STEP_LABELS[s].padEnd(40)} ${ms(c.base.median)} ${ms(c.head.median)} ${change} ${ms(c.base.p95)} ${ms(c.head.p95)}${c.regressed ? "  SLOWER" : ""}`,
    );
  });
  return lines.join("\n");
}

/** The trees to time: the base in a temporary worktree (when there is one), then this tree. */
async function prepareTrees(baseSha: string | null): Promise<Tree[]> {
  const trees: Tree[] = [];
  if (baseSha !== null) {
    const path = join(CACHE_ROOT, `base-${process.pid}`);
    cleanups.push(() => removeWorktree(HEAD_ROOT, path));
    warn(`base ${baseSha.slice(0, 9)}: checking out and installing`);
    await addBaseWorktree(HEAD_ROOT, baseSha, path);
    trees.push({ name: "base", root: path });
  }
  trees.push({ name: "head", root: HEAD_ROOT });
  return trees;
}

/** Interleaved rounds: every tree takes its turn before any tree goes again. */
async function measure(
  args: Args,
  trees: Tree[],
  scratch: string,
): Promise<Record<Tree["name"], Samples>> {
  const fixtures = join(scratch, "fixtures");
  writeFixtures(fixtures);
  // One stub port for the whole run: the build of the app is made for it and so is each preview.
  const stubPort = await freePort();
  if (args.only.includes("server-build")) {
    for (const t of trees) {
      warn(`${t.name}: building the web app`);
      await buildWeb(t.root, stubPort);
    }
  }
  const samples = { base: new Map<StepId, number[]>(), head: new Map<StepId, number[]>() };
  const slowDiffMs = process.env["PIXELSLASH_PERF_SLOW_DIFF_MS"];
  for (let round = 1; round <= args.runs; round += 1) {
    for (const t of trees) {
      warn(`round ${round}/${args.runs}: ${t.name}`);
      const tmp = join(scratch, `tmp-${t.name}`);
      mkdirSync(tmp, { recursive: true });
      const got = await probe(t.root, {
        fixtures,
        stubPort,
        tmp,
        steps: args.only,
        ...(t.name === "head" && slowDiffMs ? { slowDiffMs } : {}),
      });
      for (const s of args.only)
        samples[t.name].set(s, [...(samples[t.name].get(s) ?? []), ...(got[s] ?? [])]);
    }
  }
  return samples;
}

const dump = (m: Samples) => Object.fromEntries(m);
const summary = (samples: Samples, step: StepId): Summary => summarise(samples.get(step) ?? []);

/** `--impl`: the implementations take turns on the diff fixtures; exit 1 if any of them failed. */
async function mainImpls(args: Args): Promise<number> {
  const scratch = join(CACHE_ROOT, `run-${process.pid}`);
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const fixtures = join(scratch, "fixtures");
  writeFixtures(fixtures);
  const measured = await measureImpls(args.impls, args.only, {
    fixtures,
    rounds: args.runs,
    timeoutMs: args.timeoutMs,
    decode: args.decode ?? undefined,
    progress: (line) => warn(`impl: ${line}`),
  });
  say("");
  say(
    `perf: ${args.impls.length} implementation${args.impls.length === 1 ? "" : "s"}, ${args.runs} rounds interleaved (A B A B ...) after a warm-up round, this machine, this run.`,
  );
  say(
    "decode, diff and self (their sum) are each implementation's own ms, median; wall is the whole process.",
  );
  say(implTable(measured, args.only));
  const phases = phaseTable(measured, args.only);
  if (phases !== "") {
    say("");
    say(
      `phases are each implementation's own ms; startup is spawn to first engine code, rest is wall - startup - decode - diff.${args.decode === "parallel" ? " With --decode parallel the decode_* phases are summed work over both files and decode is the wall." : ""}`,
    );
    say(phases);
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ runs: args.runs, decode: args.decode, impls: implDump(measured) }, null, 2)}\n`,
  );
  say(`numbers: ${file}`);
  const failed = implFailures(measured);
  if (failed.length === 0) return 0;
  say("");
  for (const f of failed) say(`FAIL ${f}`);
  return 1;
}

async function main(args: Args): Promise<number> {
  if (args.impls.length > 0) return mainImpls(args);
  await sweepStale(HEAD_ROOT);
  const baseSha = await pickBase(HEAD_ROOT, args.base);
  // The head side times the working tree, so say when that is more than the commit.
  const dirty = (await run(["git", "status", "--porcelain"], HEAD_ROOT)).out !== "";
  const headSha = `${((await resolveRef(HEAD_ROOT, "HEAD")) ?? "unknown").slice(0, 9)}${dirty ? "+dirty" : ""}`;
  const scratch = join(CACHE_ROOT, `run-${process.pid}`);
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));

  const samples = await measure(args, await prepareTrees(baseSha), scratch);
  const head = args.only.map((s) => summary(samples.head, s));
  const rows =
    baseSha === null
      ? null
      : args.only.map((s) => compare(s, summary(samples.base, s), summary(samples.head, s)));
  return report(args, { baseSha, headSha, rows, head, samples });
}

type Outcome = {
  baseSha: string | null;
  headSha: string;
  rows: Comparison[] | null;
  head: Summary[];
  samples: Record<Tree["name"], Samples>;
};

/** Print the table, write the numbers, and say whether the check passed (0) or failed (1). */
function report(args: Args, { baseSha, headSha, rows, head, samples }: Outcome): number {
  say("");
  say(
    baseSha === null
      ? `perf: head ${headSha} alone, ${args.runs} rounds. No base ref is available, so no comparison was made.`
      : `perf: base ${baseSha.slice(0, 9)} against head ${headSha}, ${args.runs} rounds interleaved (A B A B ...), this machine, this run.`,
  );
  say(table(rows, head, args.only));

  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ baseSha, headSha, runs: args.runs, rows, head, samples: { base: dump(samples.base), head: dump(samples.head) } }, null, 2)}\n`,
  );
  say(`numbers: ${file}`);

  const slow = (rows ?? []).filter((c) => c.regressed);
  if (!args.check || slow.length === 0) return 0;
  say("");
  for (const c of slow) say(`FAIL ${regressionLine(c)}`);
  return 1;
}

let code = 2;
try {
  code = await main(parseArgs(process.argv.slice(2)));
} catch (e) {
  warn(e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}
process.exit(code);
