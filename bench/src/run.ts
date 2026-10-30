#!/usr/bin/env bun
/**
 * `bun run bench` (ob 1477, ob 1488): feed every labelled pair in bench/corpus/ and
 * bench/corpus-holdout/ to PixelSlash's diff and to Argos, score both, and write
 * bench/results/<date>.{md,json} plus the side-by-side disagreement page.
 *
 *   bun bench/src/run.ts [--no-argos] [--refresh-argos] [--calibration] [--capture]
 *                        [--impl <cmd> [--timeout-ms <n>]]
 *
 * Argos's verdicts come from bench/argos-cache.json, so no VM is needed. --refresh-argos asks
 * the argos-bench VM (ops/argos-bench/run-pairs.sh, ARGOS_BENCH_HOST / ARGOS_BENCH_KEY) about the pairs the
 * cache does not know and rewrites the cache. --no-argos scores PixelSlash alone and writes no
 * files. --calibration adds Argos's own 19 cases, which are streamed from the VM. --capture adds
 * the capture stage (ob 1489): fixture pages captured in the pinned image and bare. It needs Docker
 * and is skipped with a message without it; Argos is not involved. --impl <cmd> (ob 1909) scores an
 * outside implementation of the diff contract (bench/README.md) in the PixelSlash columns instead of
 * the in-process engine; it prints the tables and writes nothing.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARGOS_THRESHOLD, argosVerdicts } from "./argos-cache.ts";
import { runCalibration, type CalibrationRow } from "./calibration.ts";
import { captureSection } from "./capture-render.ts";
import { runCaptureStage, type CaptureStage } from "./capture-stage.ts";
import { BENCH_DIR, caseKey, loadCorpora, type CorpusCase } from "./corpus.ts";
import { argvReader, positiveInt } from "./impl/flags.ts";
import { DEFAULT_TIMEOUT_MS } from "./impl/invoke.ts";
import { failureLines, runImplCorpus } from "./impl/corpus.ts";
import { disagreementCases, disagreementsHtml } from "./html.ts";
import { runPixelslash } from "./pixelslash.ts";
import { resultsMarkdown, summaryMarkdown, type RunInfo } from "./render.ts";
import { CORPUS_IDS } from "./corpus.ts";
import { RESULTS_DIR, summarise, type ResultsFile } from "./results-json.ts";
import { say, warn } from "./say.ts";
import type { CaseResult, ToolResult } from "./types.ts";

const USAGE =
  "usage: bun bench/src/run.ts [--no-argos] [--refresh-argos] [--calibration] [--capture] [--impl <cmd> [--timeout-ms <n>]]";

type Flags = {
  argos: boolean;
  refresh: boolean;
  calibration: boolean;
  capture: boolean;
  /** An outside implementation of the diff contract, scored instead of the in-process engine. */
  impl: string | null;
  timeoutMs: number;
  date: string;
};

const SWITCHES: Record<string, (f: Flags) => void> = {
  "--no-argos": (f) => void (f.argos = false),
  "--refresh-argos": (f) => void (f.refresh = true),
  "--calibration": (f) => void (f.calibration = true),
  "--capture": (f) => void (f.capture = true),
};

const VALUED: Record<string, (f: Flags, raw: string) => void> = {
  "--impl": (f, raw) => void (f.impl = raw),
  "--timeout-ms": (f, raw) => void (f.timeoutMs = positiveInt("--timeout-ms", raw)),
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    argos: true,
    refresh: false,
    calibration: false,
    capture: false,
    impl: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    date: new Date().toISOString().slice(0, 10),
  };
  const args = argvReader(argv, USAGE);
  for (let a = args.next(); a !== undefined; a = args.next()) {
    const flag = SWITCHES[a];
    const valued = VALUED[a];
    if (flag) flag(flags);
    else if (valued) valued(flags, args.value(a));
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  checkFlags(flags);
  return flags;
}

function checkFlags(flags: Flags): void {
  if (flags.refresh && !flags.argos) throw new Error("--refresh-argos needs Argos");
  if (flags.calibration && !flags.argos) throw new Error("--calibration needs Argos");
  if (flags.impl !== null && (flags.calibration || flags.capture || flags.refresh))
    throw new Error(
      "--impl scores the corpora only and writes nothing; --calibration, --capture and --refresh-argos are for the in-process engine",
    );
}

async function capture(cmd: string[]): Promise<string | null> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

async function pixelslashCommit(): Promise<string> {
  const root = join(BENCH_DIR, "..");
  const sha = (await capture(["git", "-C", root, "rev-parse", "--short", "HEAD"])) ?? "unknown";
  const dirty = await capture(["git", "-C", root, "status", "--porcelain", "packages/engine"]);
  return dirty ? `${sha}+dirty` : sha;
}

function pair(
  corpus: CorpusCase[],
  ps: Map<string, ToolResult>,
  argos: Map<string, ToolResult> | null,
): CaseResult[] {
  return corpus.map((c) => {
    const pixelslash = ps.get(caseKey(c));
    if (!pixelslash) throw new Error(`no PixelSlash result for ${caseKey(c)}`);
    const theirs = argos?.get(caseKey(c)) ?? null;
    if (argos && !theirs) throw new Error(`no Argos verdict for ${caseKey(c)}`);
    return { case: c, pixelslash, argos: theirs };
  });
}

function resultsJson(rows: CaseResult[], info: RunInfo): ResultsFile {
  const own = (id: (typeof CORPUS_IDS)[number]) => rows.filter((r) => r.case.corpus === id);
  const withArgos = info.argosCommit !== null;
  return {
    version: 1,
    date: info.date,
    pixelslashCommit: info.pixelslashCommit,
    argos: info.argosCommit ? { commit: info.argosCommit, threshold: ARGOS_THRESHOLD } : null,
    corpora: {
      main: summarise(own("main"), withArgos),
      holdout: summarise(own("holdout"), withArgos),
    },
  };
}

/** The markdown, the json beside it, the disagreement page and the diff images it shows. */
function writeResults(
  rows: CaseResult[],
  flags: Flags,
  info: RunInfo,
  extra: { cal: CalibrationRow[] | null; captured: CaptureStage | null },
): void {
  const dayDir = join(RESULTS_DIR, flags.date);
  rmSync(dayDir, { recursive: true, force: true });
  for (const id of CORPUS_IDS) mkdirSync(join(dayDir, "diffs", id), { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `${flags.date}.md`),
    resultsMarkdown(rows, info, extra.cal, extra.captured),
  );
  writeFileSync(
    join(RESULTS_DIR, `${flags.date}.json`),
    `${JSON.stringify(resultsJson(rows, info), null, 2)}\n`,
  );
  const { verdict, location } = disagreementCases(rows);
  for (const r of verdict.concat(location)) {
    const { name, corpus } = r.case;
    if (r.pixelslash.diffPng)
      writeFileSync(join(dayDir, "diffs", corpus, `${name}.pixelslash.png`), r.pixelslash.diffPng);
    if (r.argos?.diffPng)
      writeFileSync(join(dayDir, "diffs", corpus, `${name}.argos.png`), r.argos.diffPng);
  }
  writeFileSync(join(dayDir, "disagreements.html"), disagreementsHtml(rows, flags.date));
}

/** The capture stage when asked for: printed here, and returned for the results file. Null when skipped. */
async function captureStage(flags: Flags): Promise<CaptureStage | null> {
  const stage = flags.capture ? await runCaptureStage() : null;
  if (stage) say(`\n${captureSection(stage)}\n`);
  return stage;
}

/** The rows to report: the in-process engine, or the outside implementation's answers, against Argos. */
async function score(flags: Flags, corpus: CorpusCase[]) {
  const outside = flags.impl === null ? null : await runImpl(flags.impl, corpus, flags.timeoutMs);
  const ps = outside?.results ?? runPixelslash(corpus);
  const argos = flags.argos ? await argosVerdicts(corpus, flags.refresh) : null;
  if (argos?.refreshed) say(`argos: ${argos.refreshed} pair(s) added to bench/argos-cache.json`);
  // A case the implementation could not answer has no result; the others are still scored.
  const answered = outside ? corpus.filter((c) => ps.has(caseKey(c))) : corpus;
  return { outside, argos, rows: pair(answered, ps, argos?.results ?? null) };
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const corpus = loadCorpora();
  say(
    `corpora: ${corpus.length} pairs (${CORPUS_IDS.map((id) => `${corpus.filter((c) => c.corpus === id).length} ${id}`).join(", ")})`,
  );
  const { outside, argos, rows } = await score(flags, corpus);
  say(`\n${summaryMarkdown(rows)}\n`);
  if (outside) {
    say(`--impl: the PixelSlash columns above are \`${flags.impl}\`; nothing written`);
    return outside.failures.length > 0 ? 1 : 0;
  }
  const captured = await captureStage(flags);
  if (!flags.argos) {
    say("--no-argos: nothing written");
    return 0;
  }
  let cal: CalibrationRow[] | null = null;
  if (flags.calibration) {
    say("calibration: Argos's own cases");
    cal = await runCalibration();
  }
  const info: RunInfo = {
    date: flags.date,
    pixelslashCommit: await pixelslashCommit(),
    argosCommit: argos?.commit ?? null,
  };
  writeResults(rows, flags, info, { cal, captured });
  say(`wrote bench/results/${flags.date}.md, .json and ${flags.date}/disagreements.html`);
  return 0;
}

/** The corpora through an outside implementation; the failures are printed here, by name, and returned. */
async function runImpl(command: string, corpus: CorpusCase[], timeoutMs: number) {
  say(`impl: \`${command}\` on ${corpus.length} pairs`);
  const run = await runImplCorpus(command, corpus, timeoutMs);
  if (run.failures.length > 0) {
    warn(`impl: ${run.failures.length} of ${corpus.length} pairs failed and are not scored:`);
    warn(failureLines(run.failures));
  }
  if (run.results.size === 0) throw new Error("impl: no pair was answered");
  return run;
}

try {
  process.exitCode = await main();
} catch (err) {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
