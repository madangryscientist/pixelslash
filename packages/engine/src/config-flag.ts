import type { Fail } from "./diff-options.ts";

/** An on/off setting; absent is off. */
export function flag(v: unknown, where: string, fail: Fail): boolean {
  if (v !== undefined && typeof v !== "boolean") fail(where, "must be true or false");
  return v ?? false;
}
