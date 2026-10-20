#!/usr/bin/env bun
/**
 * `bun run bench` (ob 1477, ob 1488): feed every labelled pair in bench/corpus/ and
 * bench/corpus-holdout/ to PixelSlash's diff and to Argos, score both, and write
 * bench/results/<date>.{md,json} plus the side-by-side disagreement page.
 *
 *   bun bench/src/run.ts [--no-argos] [--refresh-argos] [--calibration]
 *
 * Argos's verdicts come from bench/argos-cache.json, so no VM is needed. --refresh-argos asks
 * VM 101 (ops/argos-bench/run-pairs.sh, ARGOS_BENCH_HOST / ARGOS_BENCH_KEY) about the pairs the
 * cache does not know and rewrites the cache. --no-argos scores PixelSlash alone and writes no
 * files. --calibration adds Argos's own 19 cases, which are streamed from the VM.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARGOS_THRESHOLD, argosVerdicts } from "./argos-cache.ts";
import { runCalibration, type CalibrationRow } from "./calibration.ts";
import { BENCH_DIR, caseKey, loadCorpora, type CorpusCase } from "./corpus.ts";
import { disagreementCases, disagreementsHtml } from "./html.ts";
import { runPixelslash } from "./pixelslash.ts";
import { resultsMarkdown, summaryMarkdown, type RunInfo } from "./render.ts";
import { CORPUS_IDS } from "./corpus.ts";
import { RESULTS_DIR, summarise, type ResultsFile } from "./results-json.ts";
import { say, warn } from "./say.ts";
import type { CaseResult, ToolResult } from "./types.ts";

const USAGE = "usage: bun bench/src/run.ts [--no-argos] [--refresh-argos] [--calibration]";

type Flags = { argos: boolean; refresh: boolean; calibration: boolean; date: string };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    argos: true,
    refresh: false,
    calibration: false,
    date: new Date().toISOString().slice(0, 10),
  };
  for (const a of argv) {
    if (a === "--no-argos") flags.argos = false;
    else if (a === "--refresh-argos") flags.refresh = true;
    else if (a === "--calibration") flags.calibration = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (flags.refresh && !flags.argos) throw new Error("--refresh-argos needs Argos");
  if (flags.calibration && !flags.argos) throw new Error("--calibration needs Argos");
  return flags;
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
  cal: CalibrationRow[] | null,
): void {
  const dayDir = join(RESULTS_DIR, flags.date);
  rmSync(dayDir, { recursive: true, force: true });
  for (const id of CORPUS_IDS) mkdirSync(join(dayDir, "diffs", id), { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${flags.date}.md`), resultsMarkdown(rows, info, cal));
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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const corpus = loadCorpora();
  say(
    `corpora: ${corpus.length} pairs (${CORPUS_IDS.map((id) => `${corpus.filter((c) => c.corpus === id).length} ${id}`).join(", ")})`,
  );
  const ps = runPixelslash(corpus);
  const argos = flags.argos ? await argosVerdicts(corpus, flags.refresh) : null;
  if (argos?.refreshed) say(`argos: ${argos.refreshed} pair(s) added to bench/argos-cache.json`);
  const rows = pair(corpus, ps, argos?.results ?? null);
  say(`\n${summaryMarkdown(rows)}\n`);
  if (!flags.argos) {
    say("--no-argos: nothing written");
    return;
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
  writeResults(rows, flags, info, cal);
  say(`wrote bench/results/${flags.date}.md, .json and ${flags.date}/disagreements.html`);
}

try {
  await main();
} catch (err) {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
