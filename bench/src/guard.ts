/**
 * The regression guard (ob 1488): PixelSlash's three headline numbers on each corpus, now against
 * the last committed results file. Real changes caught must not fall; noise and identical pairs
 * flagged must not rise. Fractions are compared exactly, so a corpus that grew compares by rate.
 */
import { CORPUS_IDS, type CorpusId } from "./corpus.ts";
import type { Counts, CorpusSummary } from "./results-json.ts";

export type Metric = {
  corpus: CorpusId;
  name: "real caught" | "noise flagged" | "identical flagged";
  /** Higher is better for `real caught`; lower is better for the other two. */
  higherIsBetter: boolean;
  before: { n: number; d: number };
  after: { n: number; d: number };
  worse: boolean;
};

type Fraction = { n: number; d: number };

/** a < b as fractions, without floating point; no cases of a label counts as 0. */
function lessThan(a: Fraction, b: Fraction): boolean {
  const x = a.d === 0 ? { n: 0, d: 1 } : a;
  const y = b.d === 0 ? { n: 0, d: 1 } : b;
  return x.n * y.d < y.n * x.d;
}

type Spec = Pick<Metric, "corpus" | "name" | "higherIsBetter" | "before" | "after">;

function metric(spec: Spec): Metric {
  const { higherIsBetter, before, after } = spec;
  const worse = higherIsBetter ? lessThan(after, before) : lessThan(before, after);
  return { ...spec, worse };
}

export function compareCounts(corpus: CorpusId, before: Counts, after: Counts): Metric[] {
  return [
    metric({
      corpus,
      name: "real caught",
      higherIsBetter: true,
      before: { n: before.realCaught, d: before.realTotal },
      after: { n: after.realCaught, d: after.realTotal },
    }),
    metric({
      corpus,
      name: "noise flagged",
      higherIsBetter: false,
      before: { n: before.noiseFlagged, d: before.noiseTotal },
      after: { n: after.noiseFlagged, d: after.noiseTotal },
    }),
    metric({
      corpus,
      name: "identical flagged",
      higherIsBetter: false,
      before: { n: before.identicalFlagged, d: before.identicalTotal },
      after: { n: after.identicalFlagged, d: after.identicalTotal },
    }),
  ];
}

export type Flip = { corpus: CorpusId; name: string; flagged: boolean };

/** Cases both files know whose PixelSlash verdict changed: the cases behind a delta. */
export function verdictFlips(
  corpus: CorpusId,
  before: CorpusSummary["verdicts"],
  after: CorpusSummary["verdicts"],
): Flip[] {
  return Object.entries(after)
    .filter(([name, flagged]) => name in before && before[name] !== flagged)
    .map(([name, flagged]) => ({ corpus, name, flagged }));
}

const pct = (m: { n: number; d: number }) =>
  m.d === 0 ? "n/a" : `${Math.round((100 * m.n) / m.d)}%`;
const show = (m: { n: number; d: number }) => `${m.n}/${m.d} (${pct(m)})`;

/** Cases only one of the two files knows: a changed case set moves the denominators silently. */
export function caseSetChanges(
  corpus: CorpusId,
  before: CorpusSummary["verdicts"],
  after: CorpusSummary["verdicts"],
): { corpus: CorpusId; added: string[]; removed: string[] } {
  return {
    corpus,
    added: Object.keys(after).filter((n) => !(n in before)),
    removed: Object.keys(before).filter((n) => !(n in after)),
  };
}

export type GuardReport = { metrics: Metric[]; flips: Flip[]; regressed: boolean; text: string };

function metricLine(m: Metric): string {
  const same = m.before.n === m.after.n && m.before.d === m.after.d;
  let mark = same ? "same" : "better";
  if (m.worse) mark = "WORSE";
  return `${m.corpus.padEnd(8)} ${m.name.padEnd(18)} ${show(m.before)} -> ${show(m.after)}  ${mark}`;
}

function caseSetLines(
  baseline: Record<CorpusId, CorpusSummary>,
  current: Record<CorpusId, CorpusSummary>,
): string[] {
  const lines: string[] = [];
  for (const id of CORPUS_IDS) {
    const { added, removed } = caseSetChanges(id, baseline[id].verdicts, current[id].verdicts);
    if (added.length + removed.length === 0) continue;
    lines.push(
      "",
      `${id}: the case set differs from the baseline (${added.length} added, ${removed.length} removed), so the rates above compare different cases.`,
      ...removed.map((n) => `  removed: ${n}`),
      ...added.map((n) => `  added: ${n}`),
    );
  }
  return lines;
}

export function guard(
  baseline: Record<CorpusId, CorpusSummary>,
  current: Record<CorpusId, CorpusSummary>,
  baselineName: string,
): GuardReport {
  const metrics = CORPUS_IDS.flatMap((id) =>
    compareCounts(id, baseline[id].pixelslash, current[id].pixelslash),
  );
  const flips = CORPUS_IDS.flatMap((id) =>
    verdictFlips(id, baseline[id].verdicts, current[id].verdicts),
  );
  const regressed = metrics.some((m) => m.worse);
  const lines = [
    `PixelSlash against ${baselineName}:`,
    "",
    ...metrics.map(metricLine),
    ...caseSetLines(baseline, current),
  ];
  if (flips.length > 0) {
    lines.push("", "Cases whose verdict changed:");
    for (const f of flips) {
      lines.push(`  ${f.corpus}/${f.name}: now ${f.flagged ? "flagged" : "not flagged"}`);
    }
  }
  lines.push(
    "",
    regressed ? "FAIL: a score is worse than the committed results." : "ok: no score is worse.",
  );
  return { metrics, flips, regressed, text: lines.join("\n") };
}
