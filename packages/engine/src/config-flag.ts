import type { Fail } from "./diff-options.ts";

/** An on/off setting; absent is off. */
export function flag(v: unknown, where: string, fail: Fail): boolean {
  if (v !== undefined && typeof v !== "boolean") fail(where, "must be true or false");
  return v ?? false;
}

/** Two entries of one list may not share a name. */
export function uniqueNames(items: { name: string }[], what: string, fail: Fail): void {
  const seen = new Set<string>();
  for (const { name } of items) {
    if (seen.has(name)) fail(what, `has two entries named "${name}"`);
    seen.add(name);
  }
}
