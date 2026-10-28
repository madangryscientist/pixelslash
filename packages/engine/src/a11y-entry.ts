import type { Fail } from "./diff-options.ts";

/**
 * A shot's accessibility findings as the manifest carries them (PS-238), their parser and the
 * Main-versus-Branch comparison. No runtime imports, so the review app reads the same shape the
 * CLI writes.
 */

export const IMPACTS = ["minor", "moderate", "serious", "critical"] as const;
export type Impact = (typeof IMPACTS)[number];

/** One element failing one rule. `selector` is axe's own path to the element, frames joined with ` >> `. */
export type A11yViolation = {
  /** axe's rule id, e.g. `color-contrast`. */
  rule: string;
  impact: Impact | null;
  /** The rule's one-line help text, e.g. "Elements must meet minimum color contrast ratio thresholds". */
  help: string;
  selector: string;
};

/**
 * What one scan found. The field existing on a manifest entry means the page was scanned; a shot
 * that was not scanned has no `a11y`, and nothing is claimed about it. `omitted` counts the
 * violations past `MAX_VIOLATIONS` that capture did not keep (absent when none were cut).
 */
export type A11y = { violations: A11yViolation[]; omitted?: number };

/** The most violations one shot keeps; a page with more is failing the same rule everywhere. */
export const MAX_VIOLATIONS = 200;

/** The longest selector or help text kept; capture cuts a longer one. */
export const MAX_TEXT = 500;

function text(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(where, "must be a non-empty string");
  if (v.length > MAX_TEXT) fail(where, `must be at most ${MAX_TEXT} characters`);
  return v;
}

/** A manifest entry's `a11y`; `undefined` when absent (an older manifest, or a shot that was not scanned). */
export function parseA11yEntry(v: unknown, where: string, fail: Fail): A11y | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) fail(where, "must be { violations }");
  const raw: unknown = Reflect.get(v, "violations");
  if (!Array.isArray(raw)) fail(`${where}.violations`, "must be an array");
  if (raw.length > MAX_VIOLATIONS)
    fail(`${where}.violations`, `must have at most ${MAX_VIOLATIONS} violations`);
  const violations = raw.map((r, i): A11yViolation => {
    const at = `${where}.violations[${i}]`;
    if (typeof r !== "object" || r === null) fail(at, "must be an object");
    const impact: unknown = Reflect.get(r, "impact");
    const found = impact === null ? null : IMPACTS.find((k) => k === impact);
    if (found === undefined) fail(`${at}.impact`, `must be null or ${IMPACTS.join(", ")}`);
    return {
      rule: text(Reflect.get(r, "rule"), `${at}.rule`, fail),
      impact: found,
      help: text(Reflect.get(r, "help"), `${at}.help`, fail),
      selector: text(Reflect.get(r, "selector"), `${at}.selector`, fail),
    };
  });
  const omitted: unknown = Reflect.get(v, "omitted");
  if (omitted === undefined) return { violations };
  if (typeof omitted !== "number" || !Number.isInteger(omitted) || omitted < 1)
    fail(`${where}.omitted`, "must be a positive integer");
  return { violations, omitted };
}

/** The key two violations share when they are the same finding: one rule failing on one element. */
export function violationKey(v: Pick<A11yViolation, "rule" | "selector">): string {
  return `${v.rule}\n${v.selector}`;
}

/**
 * Branch's accessibility findings against Main's, like the DS judge's already/new split.
 *
 * - `off`: Branch was not scanned. Nothing is claimed.
 * - `unbaselined`: Branch was scanned and Main was not, so nothing can be called new; every
 *   violation is listed as found.
 * - `compared`: both were scanned. `fresh` is on Branch and not on Main, `already` is on both.
 *
 * `omitted` is what either side's scan did not keep: a violation counted there may be one of them.
 */
export type A11yDiff =
  | { state: "off" }
  | { state: "unbaselined"; found: A11yViolation[]; omitted: number }
  | { state: "compared"; fresh: A11yViolation[]; already: A11yViolation[]; omitted: number };

export function diffA11y(main: A11y | undefined, branch: A11y | undefined): A11yDiff {
  if (!branch) return { state: "off" };
  if (!main)
    return { state: "unbaselined", found: branch.violations, omitted: branch.omitted ?? 0 };
  const onMain = new Set(main.violations.map(violationKey));
  return {
    state: "compared",
    fresh: branch.violations.filter((v) => !onMain.has(violationKey(v))),
    already: branch.violations.filter((v) => onMain.has(violationKey(v))),
    omitted: (main.omitted ?? 0) + (branch.omitted ?? 0),
  };
}

/** One violation in a sentence: `color-contrast (serious) on .card p: Elements must meet…`. */
export function violationLine(v: A11yViolation): string {
  return `${v.rule}${v.impact ? ` (${v.impact})` : ""} on ${v.selector}: ${v.help}`;
}
