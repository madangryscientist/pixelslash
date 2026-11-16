import { defaultConcurrency } from "./capture-into.ts";
import { UsageError } from "./errors.ts";

/** The most comparisons `PIXELSLASH_DIFF_CORES` may run at once. */
const MAX_DIFF_CORES = 32;

/** The variable that caps the local comparisons a run makes at once. */
const DIFF_CORES_VAR = "PIXELSLASH_DIFF_CORES";

/**
 * How many comparisons run at once, each on its own core: `PIXELSLASH_DIFF_CORES` when it is a whole
 * number from 1 to `MAX_DIFF_CORES`, else capture's default (the free cores, at most 10, at least 1)
 * when it is unset or empty. Anything else is a `UsageError` naming the variable, which the CLI
 * turns into exit 2 before any work starts. `1` diffs in-process, one shot at a time, as before.
 */
export function diffCores(
  env: Record<string, string | undefined> = process.env,
  fallback: () => number = defaultConcurrency,
): number {
  const raw = env[DIFF_CORES_VAR];
  if (raw === undefined || raw === "") return fallback();
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIFF_CORES)
    throw new UsageError(
      `${DIFF_CORES_VAR} must be a whole number from 1 to ${MAX_DIFF_CORES} (got "${raw}")`,
    );
  return n;
}
