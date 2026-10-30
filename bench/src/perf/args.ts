/** Command line of `bun bench/src/perf/run.ts` (ob 1790). */
import { parseCpus } from "../../env/cpulist.ts";
import { argvReader, positiveInt } from "../impl/flags.ts";
import { DEFAULT_TIMEOUT_MS, type DecodeMode } from "../impl/invoke.ts";
import { defaultEnv, type EnvChoice } from "./env.ts";
import { IMPL_STEP_IDS, isStep, STEP_IDS, type StepId } from "./steps.ts";

export const USAGE =
  "usage: bun bench/src/perf/run.ts [--check] [--base <ref>] [--runs <n>] [--only <step,...>]\n" +
  "       bun bench/src/perf/run.ts --impl <cmd> [--impl <cmd> ...] [--runs <n>] [--only <step,...>] [--timeout-ms <n>]\n" +
  "                                [--decode parallel|sequential] [--env none|dedicated [--env-cpus <list>] [--env-mem <n>G|M]]";

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
  /** `--decode` handed to each implementation; null leaves it to the implementation's default (sequential). */
  decode: DecodeMode | null;
  /** `none` measures the shared desktop as it is; `dedicated` reserves cores and memory for the run (ob 1947). */
  env: EnvChoice;
};

type Parsed = { args: Args; onlyGiven: boolean; envGiven: boolean };

const SWITCHES: Record<string, (p: Parsed) => void> = {
  "--check": (p) => void (p.args.check = true),
};

const VALUED: Record<string, (p: Parsed, raw: string) => void> = {
  "--base": (p, raw) => void (p.args.base = raw),
  "--runs": (p, raw) => void (p.args.runs = positiveInt("--runs", raw)),
  "--impl": (p, raw) => void p.args.impls.push(raw),
  "--timeout-ms": (p, raw) => void (p.args.timeoutMs = positiveInt("--timeout-ms", raw)),
  "--decode": (p, raw) => {
    if (raw !== "parallel" && raw !== "sequential")
      throw new Error(`--decode must be parallel or sequential, got ${raw}\n${USAGE}`);
    p.args.decode = raw;
  },
  "--env": (p, raw) => {
    if (raw !== "none" && raw !== "dedicated")
      throw new Error(`--env must be none or dedicated, got ${raw}\n${USAGE}`);
    p.args.env.name = raw;
  },
  "--env-cpus": (p, raw) => {
    parseCpus(raw);
    p.envGiven = true;
    p.args.env.cpus = raw;
  },
  "--env-mem": (p, raw) => {
    if (!/^[1-9][0-9]{0,2}[MG]$/.test(raw))
      throw new Error(`--env-mem must look like 4G or 512M, got ${raw}\n${USAGE}`);
    p.envGiven = true;
    p.args.env.mem = raw;
  },
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
      decode: null,
      env: defaultEnv(),
    },
    onlyGiven: false,
    envGiven: false,
  };
  const reader = argvReader(argv, USAGE);
  for (let a = reader.next(); a !== undefined; a = reader.next()) {
    const flag = SWITCHES[a];
    const valued = VALUED[a];
    if (flag) flag(parsed);
    else if (valued) valued(parsed, reader.value(a));
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (parsed.envGiven && parsed.args.env.name !== "dedicated")
    throw new Error(`--env-cpus and --env-mem apply to --env dedicated only\n${USAGE}`);
  return withImpls(parsed.args, parsed.onlyGiven);
}

/** `--impl` compares implementations, not refs, and only the diff steps have a contract to time. */
function withImpls(args: Args, onlyGiven: boolean): Args {
  if (args.impls.length === 0) {
    if (args.env.name !== "none")
      throw new Error(
        `--env dedicated times --impl runs only (the ref comparison builds the web app)\n${USAGE}`,
      );
    if (args.decode !== null) throw new Error(`--decode applies to --impl only\n${USAGE}`);
    return args;
  }
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
