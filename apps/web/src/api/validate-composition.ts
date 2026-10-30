import {
  type Composition,
  MAX_FINDINGS,
  parseCompositionEntry,
} from "@pixelslash/engine/composition-entry";

export { MAX_FINDINGS };

/**
 * A composition-only shot's findings (ob 1850), checked with the engine's own manifest parser;
 * `bad` throws the caller's 400. Absent is null. Capture keeps at most `MAX_FINDINGS` and counts
 * the rest in `omitted`, so a CLI never sends more.
 */
export function composition(
  v: unknown,
  bad: (where: string, what: string) => never,
): Composition | null {
  const found = parseCompositionEntry(v, "composition", bad);
  if (!found) return null;
  if (found.gaps.length + found.special.length > MAX_FINDINGS)
    bad("composition", `must have at most ${MAX_FINDINGS} gaps and special cases`);
  return found;
}
