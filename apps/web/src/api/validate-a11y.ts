import { type A11y, parseA11yEntry } from "@pixelslash/engine/a11y-entry";

/**
 * A shot's accessibility scan (PS-238), checked with the engine's own manifest parser; `bad`
 * throws the caller's 400. Absent is null: the shot was not scanned. The parser caps the list at
 * `MAX_VIOLATIONS` and each text at `MAX_TEXT`, so a CLI never sends more.
 */
export function a11y(v: unknown, bad: (where: string, what: string) => never): A11y | null {
  return parseA11yEntry(v === null ? undefined : v, "a11y", bad) ?? null;
}
