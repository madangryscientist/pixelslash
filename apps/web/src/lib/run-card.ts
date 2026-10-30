import type { AiUsage } from "#/db/schema";
import { formatDuration, formatNumber } from "./format";
import type { StepStats } from "./timings";
import {
  type MetricBuild,
  type MetricShot,
  type Source,
  compareTimes,
  countRun,
  runTokens,
  wallMs,
} from "./run-metrics";

/**
 * The words of the build page's "This run" card (PS-233), so they are tested without a browser.
 * A figure nobody recorded gets no line; when nothing was, the card says so in a sentence.
 */

/** One line of the card: what it measures, its value, and who recorded it. */
export type CardLine = { key: string; label: string; value: string; source: string; note?: string };

const SOURCE_LABEL: Record<Source, string> = {
  server: "stored by the server",
  cli: "sent by the CLI",
  derived: "derived from stored times",
};

export const NO_TIMINGS =
  "No run timings were recorded for this build: it predates them, or it has not finished a server step.";
export const NOT_REPORTED = "usage not reported by the endpoint";
const TOKENS_SOURCE = "reported by the model's endpoint, stored by the server";
const COUNTS_SOURCE = "derived from the stored shots";

export type RunCardInput = {
  build: MetricBuild & { rerun: boolean };
  shots: readonly MetricShot[];
  defaultBranch: string;
  /** Flake re-captures the CLI sent for this build; null when it sent none. */
  recaptures: number | null;
};

export type RunCard = {
  wall: CardLine | null;
  counts: CardLine[];
  compare: CardLine | null;
  tokens: CardLine[];
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`;

function wallLine(build: RunCardInput["build"]): CardLine | null {
  const ms = wallMs(build);
  if (ms === null) return null;
  const line: CardLine = {
    key: "wall",
    label: "Wall time",
    value: formatDuration(ms),
    source: `${SOURCE_LABEL.derived}: uploaded to the last server step`,
  };
  if (build.rerun) line.note = "spans every run of the build";
  return line;
}

const countLine = (key: string, label: string, n: number): CardLine => ({
  key,
  label,
  value: formatNumber(n),
  source: COUNTS_SOURCE,
});

function countLines({ build, shots, defaultBranch, recaptures }: RunCardInput): CardLine[] {
  const counts = countRun(build, shots, defaultBranch);
  const lines = [countLine("shots", "Shots in the build", counts.shots)];
  if (counts.compares.server > 0 || counts.compares.ci === 0)
    lines.push(countLine("compares", "Compares on the server", counts.compares.server));
  if (counts.compares.ci > 0)
    lines.push(countLine("compares-ci", "Compares by CI", counts.compares.ci));
  lines.push(countLine("unmeasured", "Shots not measured", counts.notMeasured));
  lines.push(countLine("skipped-flaky", "Shots skipped as flaky", counts.skippedFlaky));
  if (counts.autoAccepted !== null)
    lines.push(
      countLine("auto-accepted", "Auto-accepted on the default branch", counts.autoAccepted),
    );
  if (recaptures !== null)
    lines.push({
      ...countLine("recaptures", "Flake re-captures", recaptures),
      source: `${SOURCE_LABEL.cli}, for shots found flaky`,
    });
  return lines;
}

/** "median 1.2 s · p95 3.4 s (n = 20 shots)", with the tail named as what it is. */
export function statsText(stats: StepStats, unit?: string): string {
  const tail =
    stats.tail === "p95"
      ? `p95 ${formatDuration(stats.p95)}`
      : `slowest ${formatDuration(stats.max)}`;
  const n = unit ? `${formatNumber(stats.n)} ${unit}` : formatNumber(stats.n);
  return `median ${formatDuration(stats.p50)} · ${tail} (n = ${n})`;
}

function compareLine(input: RunCardInput): CardLine | null {
  const times = compareTimes(input.build, input.shots);
  if (!times) return null;
  const { stats, slowest, source } = times;
  return {
    key: "compare",
    label: "Per-compare time",
    value: statsText(stats),
    source: SOURCE_LABEL[source],
    note: `slowest: ${slowest.map((s) => `${s.label} ${formatDuration(s.ms)}`).join(", ")}`,
  };
}

function usageValue(usage: AiUsage): { value: string; note?: string } {
  const { input, output, total } = usage;
  if (input === null || output === null || total === null) return { value: NOT_REPORTED };
  const value = `in ${formatNumber(input)} · out ${formatNumber(output)} · total ${formatNumber(total)}`;
  const covers =
    usage.reported === usage.calls
      ? plural(usage.calls, "call")
      : `covers ${formatNumber(usage.reported)} of ${plural(usage.calls, "call")}; the rest did not report usage`;
  return { value, note: covers };
}

function tokenLines(input: RunCardInput): CardLine[] {
  const tokens = runTokens(input.build, input.shots);
  const lines: CardLine[] = [];
  if (tokens.explain) {
    const line: CardLine = {
      key: "tokens-explain",
      label: "Tokens: AI explanations",
      source: TOKENS_SOURCE,
      ...usageValue(tokens.explain),
    };
    if (tokens.explain.unrecorded > 0)
      line.note = `${line.note ? `${line.note}; ` : ""}not recorded for ${plural(tokens.explain.unrecorded, "explanation")} stored before tokens were`;
    lines.push(line);
  }
  if (tokens.summary)
    lines.push({
      key: "tokens-summary",
      label: "Tokens: AI summary",
      source: TOKENS_SOURCE,
      ...usageValue(tokens.summary),
    });
  return lines;
}

export function runCard(input: RunCardInput): RunCard {
  return {
    wall: wallLine(input.build),
    counts: countLines(input),
    compare: compareLine(input),
    tokens: tokenLines(input),
  };
}
