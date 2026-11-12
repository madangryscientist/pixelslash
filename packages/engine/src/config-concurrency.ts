import type { Fail } from "./diff-options.ts";

/** The most shots one capture may take at once. */
export const MAX_CONCURRENCY = 32;

/** The config's `concurrency`: unset, or a whole number from 1 to `MAX_CONCURRENCY`. */
export function parseConcurrency(v: unknown, fail: Fail): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_CONCURRENCY)
    fail("concurrency", `must be a whole number from 1 to ${MAX_CONCURRENCY}`);
  return v;
}
