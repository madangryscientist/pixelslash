import type { CaptureConfig, Route } from "./config.ts";
import type { Fail } from "./diff-options.ts";

/**
 * What the server does with a shot whose captures disagreed with each other (ob 1737): put it up
 * for review, or skip it. The CLI only measures and sends it; the server applies it.
 */
export const FLAKY_POLICIES = ["review", "skip"] as const;
export type FlakyPolicy = (typeof FLAKY_POLICIES)[number];

/** How many more times a changed shot is captured when the config does not say (ob 1737). */
export const DEFAULT_FLAKE_RETRIES = 2;

/** A flaky policy where one is allowed; `undefined` when unset. */
export function parseFlaky(v: unknown, where: string, fail: Fail): FlakyPolicy | undefined {
  if (v === undefined) return undefined;
  const policy = FLAKY_POLICIES.find((p) => p === v);
  if (!policy) fail(where, `must be ${FLAKY_POLICIES.map((p) => `"${p}"`).join(" or ")}`);
  return policy;
}

/** The config's `flake: { retries? }`. */
export function parseFlake(v: unknown, fail: Fail): { retries: number } {
  if (v === undefined) return { retries: DEFAULT_FLAKE_RETRIES };
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail("flake", "must be { retries? }");
  for (const k of Object.keys(v))
    if (k !== "retries") fail(`flake.${k}`, "is not a flake option (retries)");
  return { retries: retriesOf(Reflect.get(v, "retries"), fail) };
}

function retriesOf(v: unknown, fail: Fail): number {
  if (v === undefined) return DEFAULT_FLAKE_RETRIES;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    fail("flake.retries", "must be a non-negative integer");
  return v;
}

/** The flaky policy a shot is uploaded with: route (or story tag) > project > `"review"`. */
export function resolveFlaky(config: Pick<CaptureConfig, "flaky">, shot: Route): FlakyPolicy {
  return shot.flaky ?? config.flaky ?? "review";
}
