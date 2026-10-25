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

/** The plain name of each kind, as the lists and gap pages say it. */
export const GAP_LABEL: Record<GapKind, string> = {
  element: "hand-styled element",
  class: "extra classes",
  style: "inline style",
};

/** What a gap adds: its classes, then its inline declarations (alone, for a `style` gap). */
export function gapWhat(gap: Pick<Gap, "kind" | "classes" | "style">): string {
  const style = gap.style && (gap.kind === "style" ? gap.style : `inline style ${gap.style}`);
  return [gap.classes.join(" "), style].filter(Boolean).join("; ");
}

/** One gap in a sentence, e.g. "hand-styled element: banner glow"; says only what the DOM showed. */
export function gapReason(gap: Pick<Gap, "kind" | "classes" | "style">, library: string): string {
  const lead =
    gap.kind === "class" ? `extra classes on a ${library} component` : GAP_LABEL[gap.kind];
  return `${lead}: ${gapWhat(gap)}`;
}

/** The boxes' colours on the review app and in `gaps.html`: one source, so the two agree. */
export const GAP_COLOUR = "#f59e0b";
export const SPECIAL_COLOUR = "#8b5cf6";

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
