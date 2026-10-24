/**
 * `bench:perf --impl <cmd> [--impl <cmd>]` (ob 1909): outside implementations of the diff contract
 * timed against each other on the phone, desktop and long fixtures. Each runs as a process per
 * sample; the time compared is its own `decode_ms` and `diff_ms`, so process start-up is not in it,
 * and the wall time of the process is reported beside them. Implementations take turns (A B A B ...)
 * for every step in every round, as the ref comparison does, so a slow patch of the machine lands on
 * all of them.
 */
import { join } from "node:path";
import { describeFailure, invokeImpl, type ImplFailure } from "../impl/invoke.ts";
import { branchFile, mainFile } from "./fixtures.ts";
import { median, percentile } from "./stats.ts";
import { STEP_LABELS, type StepId } from "./steps.ts";
import { running } from "./worktree.ts";

type ImplSamples = { decode: number[]; diff: number[]; wall: number[] };

/** One implementation on one step: its samples, or the failure that ended it (the rest of its rounds are skipped). */
type ImplStep = { samples: ImplSamples; failure: ImplFailure | null };

export type ImplMeasured = {
  command: string;
  steps: Map<StepId, ImplStep>;
};

const empty = (): ImplStep => ({ samples: { decode: [], diff: [], wall: [] }, failure: null });

type MeasureOptions = {
  fixtures: string;
  rounds: number;
  timeoutMs: number;
  progress?: (line: string) => void;
};

/** One process run for one implementation on one step; `keep` is false for the warm-up round. */
async function sampleOnce(
  m: ImplMeasured,
  step: StepId,
  opts: MeasureOptions,
  keep: boolean,
): Promise<void> {
  const slot = m.steps.get(step);
  if (!slot || slot.failure) return;
  const run = await invokeImpl(
    m.command,
    join(opts.fixtures, mainFile(step)),
    join(opts.fixtures, branchFile(step)),
    { timeoutMs: opts.timeoutMs, running },
  );
  if (!run.ok) slot.failure = run.failure;
  else if (run.output.verdict !== "changed")
    slot.failure = { kind: "output", message: "said unchanged on a pair that differs" };
  else if (keep) {
    slot.samples.decode.push(run.output.decode_ms);
    slot.samples.diff.push(run.output.diff_ms);
    slot.samples.wall.push(run.wallMs);
  }
}

/**
 * `rounds` measured rounds after one discarded warm-up round (the first process start reads the
 * binary and the fixtures cold). A step an implementation failed on is dropped for it from then on.
 */
export async function measureImpls(
  commands: string[],
  steps: StepId[],
  opts: MeasureOptions,
): Promise<ImplMeasured[]> {
  const measured = commands.map((command) => ({
    command,
    steps: new Map<StepId, ImplStep>(steps.map((s) => [s, empty()])),
  }));
  for (let round = 0; round <= opts.rounds; round += 1) {
    opts.progress?.(round === 0 ? "warm-up round" : `round ${round}/${opts.rounds}`);
    for (const step of steps) {
      for (const m of measured) await sampleOnce(m, step, opts, round > 0);
    }
  }
  return measured;
}

const ms = (n: number): string => n.toFixed(1).padStart(9);

/** A table per step: medians of its own decode, diff and their sum, the wall time, and the sum against the first. */
export function implTable(measured: ImplMeasured[], steps: StepId[]): string {
  const lines: string[] = [];
  steps.forEach((step, si) => {
    if (si > 0) lines.push("");
    lines.push(STEP_LABELS[step]);
    lines.push(
      `  ${"implementation".padEnd(34)} ${"decode".padStart(9)} ${"diff".padStart(9)} ${"self".padStart(9)} ${"wall".padStart(9)} ${"self p95".padStart(9)} ${"vs #1".padStart(8)}   n`,
    );
    const firstSelf = selfMedian(measured[0]?.steps.get(step));
    measured.forEach((m, i) => {
      const slot = m.steps.get(step);
      const name = `#${i + 1} ${m.command}`.slice(0, 34).padEnd(34);
      const self = selfOf(slot);
      if (!slot || self.length === 0) {
        const why = slot?.failure ? `FAILED: ${describeFailure(slot.failure)}` : "no samples";
        lines.push(`  ${name} ${why}`);
        return;
      }
      const mine = median(self);
      const vs =
        firstSelf === null || firstSelf === 0 || i === 0
          ? "".padStart(8)
          : `${mine >= firstSelf ? "+" : ""}${(((mine - firstSelf) / firstSelf) * 100).toFixed(1)}%`.padStart(
              8,
            );
      lines.push(
        `  ${name} ${ms(median(slot.samples.decode))} ${ms(median(slot.samples.diff))} ${ms(mine)} ${ms(median(slot.samples.wall))} ${ms(percentile(self, 95))} ${vs} ${String(self.length).padStart(3)}${slot.failure ? `  then FAILED: ${describeFailure(slot.failure)}` : ""}`,
      );
    });
  });
  return lines.join("\n");
}

/** decode_ms + diff_ms of each sample, the number two implementations are compared on. */
function selfOf(slot: ImplStep | undefined): number[] {
  return slot ? slot.samples.decode.map((d, i) => d + (slot.samples.diff[i] ?? 0)) : [];
}

function selfMedian(slot: ImplStep | undefined): number | null {
  const self = selfOf(slot);
  return self.length === 0 ? null : median(self);
}

export const implFailures = (measured: ImplMeasured[]): string[] =>
  measured.flatMap((m, i) =>
    [...m.steps.entries()].flatMap(([step, s]) =>
      s.failure ? [`#${i + 1} ${m.command} on ${step}: ${describeFailure(s.failure)}`] : [],
    ),
  );

/** The numbers for `bench/perf-results/<time>.json`. */
export const implDump = (measured: ImplMeasured[]) =>
  measured.map((m) => ({
    command: m.command,
    steps: Object.fromEntries(
      [...m.steps].map(([step, s]) => [
        step,
        {
          ...s.samples,
          failure: s.failure ? describeFailure(s.failure) : null,
        },
      ]),
    ),
  }));
