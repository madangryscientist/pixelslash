import type { IgnoreRect } from "./diff.ts";
import type { Fail } from "./diff-options.ts";

/**
 * A shot's composition findings as the manifest carries them (ob 1850), and their parser. No
 * runtime imports, so the review app reads the same shape the CLI writes.
 */

/** The attribute that declares an element (and everything in it) a special case: its value is the reason. */
export const CUSTOM_ATTRIBUTE = "data-pixelslash-custom";

/**
 * - `element`: styled by the app alone, no library class on it (a hand-rolled styled element).
 * - `class`: a library element with classes the library does not produce added to it.
 * - `style`: an inline style the library does not set.
 */
export type GapKind = "element" | "class" | "style";

/** One element styled outside the library; `box` is in image px. */
export type Gap = {
  kind: GapKind;
  selector: string;
  tag: string;
  /** The classes no library chunk covers (all of them for `element`). */
  classes: string[];
  /** The inline declarations the library does not set, `prop: value; ...`; null when none. */
  style: string | null;
  box: IgnoreRect;
};

/** An element declared custom, with its reason; its subtree is not walked. */
export type SpecialCase = { selector: string; reason: string; box: IgnoreRect };

/**
 * One shot's findings, in the manifest beside its PNG. `library` is the configured name; `omitted`
 * counts the findings past `MAX_FINDINGS` that capture did not keep (absent when none were cut).
 */
export type Composition = {
  library: string;
  gaps: Gap[];
  special: SpecialCase[];
  omitted?: number;
};

/** The most findings one shot keeps; a page with more is mostly not built from the library. */
export const MAX_FINDINGS = 500;

/** The longest selector, class, style or reason kept; capture cuts a longer one (a `data:` URL style). */
export const MAX_TEXT = 500;

const GAP_KINDS: readonly GapKind[] = ["element", "class", "style"];

function rect(v: unknown, where: string, fail: Fail): IgnoreRect {
  if (typeof v !== "object" || v === null) fail(where, "must be { x, y, width, height }");
  const n = (k: string) => {
    const x: unknown = Reflect.get(v, k);
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0)
      fail(`${where}.${k}`, "must be a non-negative integer");
    return x;
  };
  return { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
}

function text(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(where, "must be a non-empty string");
  if (v.length > MAX_TEXT) fail(where, `must be at most ${MAX_TEXT} characters`);
  return v;
}

function list(v: unknown, where: string, fail: Fail): unknown[] {
  if (!Array.isArray(v)) fail(where, "must be an array");
  return v;
}

/** A manifest entry's `composition`; `undefined` when absent (an older manifest, or not composition-only). */
export function parseCompositionEntry(
  v: unknown,
  where: string,
  fail: Fail,
): Composition | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) fail(where, "must be { library, gaps, special }");
  const gaps = list(Reflect.get(v, "gaps"), `${where}.gaps`, fail).map((g, i): Gap => {
    const at = `${where}.gaps[${i}]`;
    if (typeof g !== "object" || g === null) fail(at, "must be an object");
    const kind = GAP_KINDS.find((k) => k === Reflect.get(g, "kind"));
    if (!kind) fail(`${at}.kind`, `must be ${GAP_KINDS.join(", ")}`);
    const style: unknown = Reflect.get(g, "style");
    return {
      kind,
      selector: text(Reflect.get(g, "selector"), `${at}.selector`, fail),
      tag: text(Reflect.get(g, "tag"), `${at}.tag`, fail),
      classes: list(Reflect.get(g, "classes"), `${at}.classes`, fail).map((c, j) =>
        text(c, `${at}.classes[${j}]`, fail),
      ),
      style: style === null ? null : text(style, `${at}.style`, fail),
      box: rect(Reflect.get(g, "box"), `${at}.box`, fail),
    };
  });
  const special = list(Reflect.get(v, "special"), `${where}.special`, fail).map(
    (s, i): SpecialCase => {
      const at = `${where}.special[${i}]`;
      if (typeof s !== "object" || s === null) fail(at, "must be an object");
      return {
        selector: text(Reflect.get(s, "selector"), `${at}.selector`, fail),
        reason: text(Reflect.get(s, "reason"), `${at}.reason`, fail),
        box: rect(Reflect.get(s, "box"), `${at}.box`, fail),
      };
    },
  );
  const library = text(Reflect.get(v, "library"), `${where}.library`, fail);
  const omitted: unknown = Reflect.get(v, "omitted");
  if (omitted === undefined) return { library, gaps, special };
  if (typeof omitted !== "number" || !Number.isInteger(omitted) || omitted < 1)
    fail(`${where}.omitted`, "must be a positive integer");
  return { library, gaps, special, omitted };
}
