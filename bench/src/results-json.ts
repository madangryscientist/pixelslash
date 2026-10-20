/**
 * The machine-readable half of a results file (ob 1488): `bench/results/<date>.json` sits beside
 * the markdown, and `bench:check` compares a fresh PixelSlash run against the latest one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, byCorpus, isRecord, type CorpusId } from "./corpus.ts";
import { scoreTool, type Tool } from "./score.ts";
import type { CaseResult } from "./types.ts";

export const RESULTS_DIR = join(BENCH_DIR, "results");

/** The three numbers the regression guard watches. */
export type Counts = {
  realCaught: number;
  realTotal: number;
  noiseFlagged: number;
  noiseTotal: number;
  identicalFlagged: number;
  identicalTotal: number;
};

export type CorpusSummary = {
  cases: number;
  pixelslash: Counts;
  argos: Counts | null;
  /** PixelSlash's verdict per case (true = flagged changed), to name the case behind a delta. */
  verdicts: Record<string, boolean>;
};

export type ResultsFile = {
  version: 1;
  date: string;
  pixelslashCommit: string;
  argos: { commit: string; threshold: number } | null;
  corpora: Record<CorpusId, CorpusSummary>;
};

export function countsFor(rows: CaseResult[], tool: Tool): Counts {
  const s = scoreTool(rows, tool);
  return {
    realCaught: s.realCaught,
    realTotal: s.realTotal,
    noiseFlagged: s.noiseFlagged,
    noiseTotal: s.noiseTotal,
    identicalFlagged: s.identicalFlagged,
    identicalTotal: s.identicalTotal,
  };
}

export function summarise(rows: CaseResult[], withArgos: boolean): CorpusSummary {
  return {
    cases: rows.length,
    pixelslash: countsFor(rows, "pixelslash"),
    argos: withArgos ? countsFor(rows, "argos") : null,
    verdicts: Object.fromEntries(rows.map((r) => [r.case.name, r.pixelslash.changed])),
  };
}

function count(raw: Record<string, unknown>, key: keyof Counts): number {
  const v = raw[key];
  if (typeof v !== "number") throw new Error(`results json: counts.${key} is not a number`);
  return v;
}

function parseCounts(raw: unknown): Counts {
  if (!isRecord(raw)) throw new Error("results json: counts is not an object");
  return {
    realCaught: count(raw, "realCaught"),
    realTotal: count(raw, "realTotal"),
    noiseFlagged: count(raw, "noiseFlagged"),
    noiseTotal: count(raw, "noiseTotal"),
    identicalFlagged: count(raw, "identicalFlagged"),
    identicalTotal: count(raw, "identicalTotal"),
  };
}

function parseCorpus(raw: unknown): CorpusSummary {
  if (!isRecord(raw)) throw new Error("results json: a corpus is not an object");
  const { cases, pixelslash, argos, verdicts } = raw;
  if (typeof cases !== "number" || !isRecord(verdicts))
    throw new Error("results json: a corpus needs cases and verdicts");
  const flags: Record<string, boolean> = {};
  for (const [name, v] of Object.entries(verdicts)) {
    if (typeof v !== "boolean")
      throw new Error(`results json: verdict for ${name} is not a boolean`);
    flags[name] = v;
  }
  return {
    cases,
    pixelslash: parseCounts(pixelslash),
    argos: argos === null || argos === undefined ? null : parseCounts(argos),
    verdicts: flags,
  };
}

export function parseResults(text: string): ResultsFile {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw["version"] !== 1) throw new Error("not a version 1 results file");
  const { date, pixelslashCommit, argos, corpora } = raw;
  if (typeof date !== "string" || typeof pixelslashCommit !== "string" || !isRecord(corpora))
    throw new Error("results json: missing date, commit or corpora");
  const out = byCorpus((id) => parseCorpus(corpora[id]));
  let argosInfo: ResultsFile["argos"] = null;
  if (
    isRecord(argos) &&
    typeof argos["commit"] === "string" &&
    typeof argos["threshold"] === "number"
  )
    argosInfo = { commit: argos["commit"], threshold: argos["threshold"] };
  return { version: 1, date, pixelslashCommit, argos: argosInfo, corpora: out };
}

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", BENCH_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

const RESULTS_JSON = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * The newest `<date>.json` as committed at HEAD, with its path. `bun run bench` rewrites today's
 * file in the working tree, so reading the tree would let a run be checked against itself.
 */
export function committedResults(): { path: string; results: ResultsFile } {
  const listed = git("ls-tree", "--name-only", "HEAD", "results/").split("\n");
  const last = listed
    .map((f) => f.slice("results/".length))
    .filter((f) => RESULTS_JSON.test(f))
    .toSorted()
    .at(-1);
  if (!last)
    throw new Error("no committed bench/results/<date>.json; run `bun run bench` and commit it");
  return { path: `results/${last}`, results: parseResults(git("show", `HEAD:./results/${last}`)) };
}

export function loadResults(file: string): ResultsFile {
  return parseResults(readFileSync(file, "utf8"));
}
