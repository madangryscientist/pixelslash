/** Command line of `bun bench/src/perf/run.ts` (ob 1790). */
import { isStep, STEP_IDS, type StepId } from "./steps.ts";

export const USAGE =
  "usage: bun bench/src/perf/run.ts [--check] [--base <ref>] [--runs <n>] [--only <step,...>]";

export const DEFAULT_RUNS = 10;

export type Args = {
  /** Exit 1 when a step is more than the limit slower on head. */
  check: boolean;
  /** The ref to compare against; null takes `origin/main`, else `main`, else no comparison. */
  base: string | null;
  runs: number;
  only: StepId[];
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, base: null, runs: DEFAULT_RUNS, only: [...STEP_IDS] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    const value = (): string => {
      const v = argv[(i += 1)];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--check") args.check = true;
    else if (a === "--base") args.base = value();
    else if (a === "--runs") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error(`--runs needs a whole number, 1 or more`);
      args.runs = n;
    } else if (a === "--only") {
      const ids = value().split(",");
      const bad = ids.filter((id) => !isStep(id));
      if (bad.length > 0)
        throw new Error(`unknown step: ${bad.join(", ")} (steps: ${STEP_IDS.join(", ")})`);
      args.only = STEP_IDS.filter((s) => ids.includes(s));
    } else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return args;
}
