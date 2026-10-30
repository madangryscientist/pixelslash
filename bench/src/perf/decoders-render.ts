/**
 * The decoder table `bench:decoders` writes (PS-168): its rows, the `bench:perf` numbers file they
 * are read from, and the markdown, `bench/results/decoders-<yyyy-mm>.md`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { median, percentile } from "./stats.ts";

export type Candidate = {
  /** The row's name in the table. */
  label: string;
  command: string;
  licence: string;
  /** Files or directories whose size is the install weight. */
  weight: string[];
  /** Why it may never ship, when it may not. */
  never?: string;
  /** Set when it cannot be timed here; the row says why. */
  missing?: string;
};

function bytesOf(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, f) => sum + bytesOf(join(path, f)), 0);
}

const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);

type Step = {
  decode: number[];
  diff: number[];
  wall: number[];
  startup: number[];
  phases: Record<string, number[]>;
  rss: number[];
  failure: string | null;
};

type Dumped = { command: string; steps: Record<string, Step> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A `bench:perf` numbers file, as far as the table reads it: each impl's command and steps. */
export function isDump(v: unknown): v is { impls: Dumped[] } {
  return (
    isObject(v) &&
    Array.isArray(v.impls) &&
    v.impls.every((d) => isObject(d) && typeof d.command === "string" && isObject(d.steps))
  );
}

const f1 = (xs: number[] | undefined): string =>
  xs && xs.length > 0 ? median(xs).toFixed(1) : "-";

const rssMb = (step: Step): string => (step.rss.length > 0 ? mb(median(step.rss)) : "-");

/** The implementation's own decode + diff per sample on `page`; none when it has no step there. */
function selfMs(d: Dumped | undefined, page: string): number[] {
  const s = d?.steps[page];
  return s ? s.decode.map((x, i) => x + (s.diff[i] ?? 0)) : [];
}

/** Why a row has no numbers on a page: not built, or failed (with the runner's reason). */
function noNumbers(r: Candidate, step: Step | undefined, missing: string): string {
  return r.missing ? missing : `failed: ${step?.failure ?? "no samples"}`;
}

type Table = { rows: Candidate[]; byCommand: Map<string, Dumped> };

/** The C# decoders' `vs baseline` column is against `stb sequential`, the decoder before PS-168. */
function baselineMs(t: Table): number | null {
  const row = t.rows.find((r) => r.label === "stb sequential");
  const xs = selfMs(t.byCommand.get(row?.command ?? ""), "diff-long");
  return xs.length > 0 ? median(xs) : null;
}

function headline(t: Table): string[] {
  return t.rows.map((r) => {
    const d = t.byCommand.get(r.command);
    const xs = selfMs(d, "diff-long");
    const step = d?.steps["diff-long"];
    if (r.missing || !step || xs.length === 0)
      return `| ${r.label} | ${noNumbers(r, step, `not built: ${r.missing}`)} | | | | | ${r.licence} | |`;
    const base = baselineMs(t);
    const vs = base === null ? "-" : `${(((median(xs) - base) / base) * 100).toFixed(0)}%`;
    return `| ${r.label} | ${median(xs).toFixed(1)} | ${percentile(xs, 95).toFixed(1)} | ${vs} | ${f1(step.decode)} | ${rssMb(step)} | ${r.licence} | ${r.never ? `never: ${r.never}` : "permissive"} |`;
  });
}

/** The decoder survey's pages: the three sizes, not the long page's small changes (PS-191). */
export const PAGES = ["diff-phone", "diff-desktop", "diff-long"] as const;
const DECODE_PHASES = ["decode_read", "decode_inflate", "decode_unfilter", "decode_other"];
const DIFF_PHASES = ["pixel_compare", "regions"];

function pageRows(t: Table, r: Candidate): string[] {
  // None of its files found (another install layout): not measured, so not 0.
  const found = r.weight.filter((w) => existsSync(w));
  const weight = found.length === 0 ? "-" : mb(found.reduce((sum, w) => sum + bytesOf(w), 0));
  const tail = `${r.licence} | ${weight} |`;
  const d = t.byCommand.get(r.command);
  return PAGES.map((page) => {
    const step = d?.steps[page];
    const xs = selfMs(d, page);
    if (r.missing || !step || xs.length === 0)
      return `| ${r.label} | ${page} | ${noNumbers(r, step, "not built")} | | | | | | | ${tail}`;
    const phases = (names: string[]) => names.map((n) => f1(step.phases[n])).join(" / ");
    return `| ${r.label} | ${page} | ${median(xs).toFixed(1)} | ${percentile(xs, 95).toFixed(1)} | ${f1(step.wall)} | ${f1(step.startup)} | ${phases(DECODE_PHASES)} | ${phases(DIFF_PHASES)} | ${rssMb(step)} | ${tail}`;
  });
}

/** `bench/results/decoders-<yyyy-mm>.md`: the headline on diff-long, then every row on every page. */
export function render(
  rows: Candidate[],
  dumped: Dumped[],
  header: string[],
  date: string,
): string {
  const t: Table = { rows, byCommand: new Map(dumped.map((d) => [d.command, d])) };
  const out: string[] = [
    `# Decoders, ${date} (PS-168)`,
    "",
    "Written by `bun run bench:decoders`; do not edit by hand. Each row is one `--impl` of `bench:perf`,",
    "all rows interleaved in one run, so the numbers compare with each other and with no other run.",
    "`self` is the implementation's own decode + diff ms; `wall` is the whole process. Peak RSS is what",
    "the process reports (`peak_rss_bytes`), runtime included. Install weight is the files the candidate adds on disk.",
    "",
    ...header.map((l) => `    ${l}`),
    "",
    "## Headline: diff-long (1440x6000)",
    "",
    "| candidate | self median | self p95 | vs baseline | decode | peak RSS MB | licence | ships? |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...headline(t),
    "",
    "## Every row, every page",
    "",
    "| candidate | page | self median | self p95 | wall | startup | decode read / inflate / unfilter / other | pixel_compare / regions | peak RSS MB | licence | install MB |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | ---: |",
    ...rows.flatMap((r) => pageRows(t, r)),
  ];
  return `${out.join("\n")}\n`;
}
