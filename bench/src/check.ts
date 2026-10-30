#!/usr/bin/env bun
/**
 * `bun run bench:check` (ob 1488): PixelSlash alone, on both corpora, against the last committed
 * results file, read from git HEAD so a run of `bun run bench` cannot move its own baseline. Exits 1, and prints the delta, when real changes caught fall or noise or identical
 * pairs flagged rise on either corpus. No VM and no browser: it reads the committed PNGs.
 *
 *   bun bench/src/check.ts [--baseline <results.json>]
 */
import { relative } from "node:path";
import { BENCH_DIR, byCorpus, loadCorpora } from "./corpus.ts";
import { guard } from "./guard.ts";
import { runPixelslash } from "./pixelslash.ts";
import { committedResults, loadResults, summarise, type ResultsFile } from "./results-json.ts";
import { say, warn } from "./say.ts";
import type { CaseResult } from "./types.ts";

const USAGE = "usage: bun bench/src/check.ts [--baseline <results.json>]";

/** The committed results file, or the one named with --baseline. */
function baseline(argv: string[]): { name: string; results: ResultsFile } {
  if (argv.length === 0) {
    const { path, results } = committedResults();
    return { name: `${path} at HEAD`, results };
  }
  const [flag, path, ...rest] = argv;
  if (flag !== "--baseline" || !path || rest.length > 0) throw new Error(USAGE);
  return { name: relative(BENCH_DIR, path), results: loadResults(path) };
}

function main(): number {
  const base = baseline(process.argv.slice(2));
  const corpus = loadCorpora();
  const ps = runPixelslash(corpus);
  const rows: CaseResult[] = corpus.map((c) => {
    const pixelslash = ps.get(`${c.corpus}/${c.name}`);
    if (!pixelslash) throw new Error(`no PixelSlash result for ${c.corpus}/${c.name}`);
    return { case: c, pixelslash, argos: null };
  });
  const current = byCorpus((id) =>
    summarise(
      rows.filter((r) => r.case.corpus === id),
      false,
    ),
  );
  const report = guard(
    base.results.corpora,
    current,
    `${base.name} (PixelSlash ${base.results.pixelslashCommit})`,
  );
  say(report.text);
  return report.regressed ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
