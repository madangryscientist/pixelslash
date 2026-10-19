#!/usr/bin/env bun
/**
 * `bun run bench` (ob 1477): feed every labelled pair in bench/corpus/ to PixelSlash's diff and to
 * Argos, score both, and write bench/results/<date>.md plus the side-by-side disagreement page.
 *
 *   bun bench/src/run.ts [--no-argos] [--calibration]
 *
 * Argos is reached through ops/argos-bench/run-pairs.sh (ARGOS_BENCH_HOST / ARGOS_BENCH_KEY), so VM
 * 101 must be up. --no-argos scores PixelSlash alone. --calibration adds Argos's own 19 cases.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argosHost, argosKey, runArgos } from "./argos.ts";
import { runCalibration, type CalibrationRow } from "./calibration.ts";
import { BENCH_DIR, CORPUS_DIR, loadCorpus, type CorpusCase } from "./corpus.ts";
import { disagreementCases, disagreementsHtml } from "./html.ts";
import { runPixelslash } from "./pixelslash.ts";
import { resultsMarkdown, summaryMarkdown, type RunInfo } from "./render.ts";
import { say, warn } from "./say.ts";
import type { CaseResult, ToolResult } from "./types.ts";

const USAGE = "usage: bun bench/src/run.ts [--no-argos] [--calibration]";

type Flags = { argos: boolean; calibration: boolean; date: string };
type ArgosRun = Awaited<ReturnType<typeof runArgos>>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    argos: true,
    calibration: false,
    date: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-argos") flags.argos = false;
    else if (a === "--calibration") flags.calibration = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
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

function argosCommit(): Promise<string | null> {
  return capture([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-i",
    argosKey(),
    argosHost(),
    "docker run --rm --network none --entrypoint git argos-bench -C /argos rev-parse HEAD",
  ]);
}

function pair(
  corpus: CorpusCase[],
  ps: Map<string, ToolResult>,
  argos: ArgosRun | null,
): CaseResult[] {
  return corpus.map((c) => {
    const pixelslash = ps.get(c.name);
    if (!pixelslash) throw new Error(`no PixelSlash result for ${c.name}`);
    const theirs = argos?.results.get(c.name) ?? null;
    if (argos && !theirs) throw new Error(`Argos returned no verdict for ${c.name}`);
    return { case: c, pixelslash, argos: theirs };
  });
}

/** The markdown, and (with Argos) the disagreement page and the diff images it shows. */
async function writeResults(
  rows: CaseResult[],
  flags: Flags,
  argos: ArgosRun | null,
  cal: CalibrationRow[] | null,
): Promise<void> {
  const resultsDir = join(BENCH_DIR, "results");
  const dayDir = join(resultsDir, flags.date);
  rmSync(dayDir, { recursive: true, force: true });
  mkdirSync(join(dayDir, "diffs"), { recursive: true });
  const info: RunInfo = {
    date: flags.date,
    pixelslashCommit: await pixelslashCommit(),
    argosCommit: flags.argos ? await argosCommit() : null,
    argosWallMs: argos?.wallMs ?? null,
  };
  writeFileSync(join(resultsDir, `${flags.date}.md`), resultsMarkdown(rows, info, cal));
  if (!argos) return;
  const { verdict, location } = disagreementCases(rows);
  for (const r of verdict.concat(location)) {
    const { name } = r.case;
    if (r.pixelslash.diffPng)
      writeFileSync(join(dayDir, "diffs", `${name}.pixelslash.png`), r.pixelslash.diffPng);
    if (r.argos?.diffPng)
      writeFileSync(join(dayDir, "diffs", `${name}.argos.png`), r.argos.diffPng);
  }
  writeFileSync(join(dayDir, "disagreements.html"), disagreementsHtml(rows, flags.date));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const corpus = loadCorpus(CORPUS_DIR);
  say(`corpus: ${corpus.length} pairs`);
  const ps = runPixelslash(corpus);
  const scratch = mkdtempSync(join(tmpdir(), "pixelslash-bench-"));
  try {
    let argos: ArgosRun | null = null;
    if (flags.argos) {
      say(`argos: sending ${corpus.length} pairs to ${argosHost()}`);
      argos = await runArgos(CORPUS_DIR, join(scratch, "argos"));
    }
    const rows = pair(corpus, ps, argos);
    let cal: CalibrationRow[] | null = null;
    if (flags.calibration) {
      say("calibration: Argos's own cases");
      cal = await runCalibration();
    }
    await writeResults(rows, flags, argos, cal);
    say(`\n${summaryMarkdown(rows)}\n`);
    say(`wrote bench/results/${flags.date}.md${argos ? " and its disagreements.html" : ""}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
