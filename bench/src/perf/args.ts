/** Command line of `bun bench/src/perf/run.ts` (ob 1790). */
import { argvReader, positiveInt } from "../impl/flags.ts";
import { DEFAULT_TIMEOUT_MS } from "../impl/invoke.ts";
import { IMPL_STEP_IDS, isStep, STEP_IDS, type StepId } from "./steps.ts";

export const USAGE =
  "usage: bun bench/src/perf/run.ts [--check] [--base <ref>] [--runs <n>] [--only <step,...>]\n" +
  "       bun bench/src/perf/run.ts --impl <cmd> [--impl <cmd> ...] [--runs <n>] [--only <step,...>] [--timeout-ms <n>]";

export const DEFAULT_RUNS = 10;

export type Args = {
  /** Exit 1 when a step is more than the limit slower on head. */
  check: boolean;
  /** The ref to compare against; null takes `origin/main`, else `main`, else no comparison. */
  base: string | null;
  runs: number;
  only: StepId[];
  /** Outside implementations of the diff contract to time against each other instead of two refs. */
  impls: string[];
  timeoutMs: number;
};

type Parsed = { args: Args; onlyGiven: boolean };

const SWITCHES: Record<string, (p: Parsed) => void> = {
  "--check": (p) => void (p.args.check = true),
};

const VALUED: Record<string, (p: Parsed, raw: string) => void> = {
  "--base": (p, raw) => void (p.args.base = raw),
  "--runs": (p, raw) => void (p.args.runs = positiveInt("--runs", raw)),
  "--impl": (p, raw) => void p.args.impls.push(raw),
  "--timeout-ms": (p, raw) => void (p.args.timeoutMs = positiveInt("--timeout-ms", raw)),
  "--only": (p, raw) => {
    p.onlyGiven = true;
    const ids = raw.split(",");
    const bad = ids.filter((id) => !isStep(id));
    if (bad.length > 0)
      throw new Error(`unknown step: ${bad.join(", ")} (steps: ${STEP_IDS.join(", ")})`);
    p.args.only = STEP_IDS.filter((s) => ids.includes(s));
  },
};

export function parseArgs(argv: string[]): Args {
  const parsed: Parsed = {
    args: {
      check: false,
      base: null,
      runs: DEFAULT_RUNS,
      only: [...STEP_IDS],
      impls: [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    onlyGiven: false,
  };
  const reader = argvReader(argv, USAGE);
  for (let a = reader.next(); a !== undefined; a = reader.next()) {
    const flag = SWITCHES[a];
    const valued = VALUED[a];
    if (flag) flag(parsed);
    else if (valued) valued(parsed, reader.value(a));
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return withImpls(parsed.args, parsed.onlyGiven);
}

/** `--impl` compares implementations, not refs, and only the diff steps have a contract to time. */
function withImpls(args: Args, onlyGiven: boolean): Args {
  if (args.impls.length === 0) return args;
  if (args.check || args.base !== null)
    throw new Error(`--impl compares implementations; --check and --base compare refs\n${USAGE}`);
  if (!onlyGiven) return { ...args, only: [...IMPL_STEP_IDS] };
  const outside = args.only.filter((s) => !IMPL_STEP_IDS.some((i) => i === s));
  if (outside.length > 0)
    throw new Error(
      `--impl times the diff steps only (${IMPL_STEP_IDS.join(", ")}), not ${outside.join(", ")}`,
    );
  return args;
}
