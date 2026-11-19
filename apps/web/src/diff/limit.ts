/**
 * `DIFF_LIMIT_MPX` as a number: unset or empty is no limit. Anything else that is not a positive
 * number throws, so a typo fails every API call naming the var, never runs a server with no limit.
 */
export function diffLimitOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new Error(`DIFF_LIMIT_MPX must be a positive number of Mpx, not ${JSON.stringify(raw)}`);
  return limit;
}
