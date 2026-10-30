import type { CustomDeclared } from "./config-composition.ts";

/**
 * The DOM walk of a composition-only capture (ob 1850), run in the page. The functions here are
 * sent to the browser as source (`walkSource`), so each is self-contained: it touches only its
 * arguments and the browser's globals.
 */

/** Browser globals the walk touches (the tsconfig has no DOM lib). Type-only. */
type StyleDecl = { length: number; [i: number]: string; getPropertyValue(p: string): string };
type El = {
  tagName: string;
  id: string;
  classList: ArrayLike<string>;
  style: StyleDecl;
  children: ArrayLike<El>;
  parentElement: El | null;
  previousElementSibling: El | null;
  nextElementSibling: El | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  checkVisibility?(options: { visibilityProperty: boolean }): boolean;
};
declare const document: {
  documentElement: El;
  querySelectorAll(selector: string): ArrayLike<El>;
};
declare const window: { scrollX: number; scrollY: number };
declare const CSS: { escape(s: string): string };

export type WalkInput = {
  chunks: string[][];
  styleProps: string[];
  custom: CustomDeclared[];
  attribute: string;
};

/** A box in CSS px from the top of the document. */
export type CssBox = { x: number; y: number; width: number; height: number };

export type Styled = {
  kind: "element" | "class" | "style";
  classes: string[];
  style: string | null;
};

export type Walked = {
  gaps: (Styled & { selector: string; tag: string; box: CssBox })[];
  special: { selector: string; reason: string; box: CssBox }[];
  /** Declared selectors the browser refused. */
  invalid: string[];
};

type Library = { byToken: Map<string, string[][]>; libraryStyle: Set<string> };

/** A selector for `el`: a unique id, else `tag:nth-of-type(n)` steps from `body`. */
function selectorOf(el: El): string {
  const parts: string[] = [];
  const count = (e: El, next: (s: El) => El | null) => {
    let n = 0;
    for (let s = next(e); s; s = next(s)) n += s.tagName === e.tagName ? 1 : 0;
    return n;
  };
  for (let e: El | null = el; e; e = e.parentElement) {
    const tag = e.tagName.toLowerCase();
    const id = e.id ? `#${CSS.escape(e.id)}` : "";
    if (id && document.querySelectorAll(id).length === 1) return [id, ...parts].join(" > ");
    if (tag === "html") break;
    const before = count(e, (s) => s.previousElementSibling);
    const alone = tag === "body" || before + count(e, (s) => s.nextElementSibling) === 0;
    parts.unshift(alone ? tag : `${tag}:nth-of-type(${before + 1})`);
  }
  return ["html", ...parts].join(" > ");
}

/**
 * What of `el`'s own styling the library does not account for, or null when nothing: classes no
 * whole chunk covers, and inline declarations (on a library element, those the library sets are
 * its own). Only a chunk of two or more classes makes `el` a library element: a one-class string
 * (`"relative"`, `"mt-1"`) is a library class but is as likely the app's own, so it covers itself
 * and no more.
 */
function styledOf(el: El, { byToken, libraryStyle }: Library): Styled | null {
  // `<html>` and `<body>` are walked through but never reported: one tints the whole shot.
  if (el === document.documentElement || el.tagName === "BODY") return null;
  const tokens = [...new Set(Array.from(el.classList))];
  const has = new Set(tokens);
  const whole = tokens.flatMap((t) =>
    (byToken.get(t) ?? []).filter((chunk) => chunk.every((c) => has.has(c))),
  );
  const covered = new Set(whole.flat());
  const library = whole.some((chunk) => chunk.length > 1);
  const classes = tokens.filter((t) => !covered.has(t));
  const decls = Array.from({ length: el.style.length }, (_, i) => el.style[i] ?? "")
    .filter((p) => !(library && libraryStyle.has(p)))
    .map((p) => `${p}: ${el.style.getPropertyValue(p)}`);
  if (classes.length === 0 && decls.length === 0) return null;
  const style = decls.length > 0 ? decls.join("; ") : null;
  if (!library && tokens.length > 0) return { kind: "element", classes, style };
  return { kind: classes.length > 0 ? "class" : "style", classes, style };
}

/** Every element from `<html>` down: the gaps, and the declared special cases (not walked into). */
function walkPage(input: WalkInput, selector: typeof selectorOf, styled: typeof styledOf): Walked {
  const skip = new Set([
    "HEAD",
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "NOSCRIPT",
    "TEMPLATE",
    "TITLE",
  ]);
  const byToken = new Map<string, string[][]>();
  for (const chunk of input.chunks)
    for (const t of chunk) byToken.set(t, [...(byToken.get(t) ?? []), chunk]);
  const lib = { byToken, libraryStyle: new Set(input.styleProps) };
  const out: Walked = { gaps: [], special: [], invalid: [] };
  // The first entry that names an element gives its reason.
  const declared = new Map<El, string>();
  for (const c of input.custom.toReversed()) {
    try {
      for (const el of Array.from(document.querySelectorAll(c.selector)))
        declared.set(el, c.reason);
    } catch {
      out.invalid.push(c.selector);
    }
  }
  const placed = (el: El): CssBox | null => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    if (el.checkVisibility?.({ visibilityProperty: true }) === false) return null;
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  };
  const visit = (el: El): void => {
    if (skip.has(el.tagName)) return;
    const reason = el.getAttribute(input.attribute) ?? declared.get(el);
    if (reason !== undefined) {
      const box = placed(el);
      if (box)
        out.special.push({ selector: selector(el), reason: reason.trim() || "(no reason)", box });
      return;
    }
    const found = styled(el, lib);
    const box = found && placed(el);
    if (found && box)
      out.gaps.push({ ...found, selector: selector(el), tag: el.tagName.toLowerCase(), box });
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(document.documentElement);
  return out;
}

/** The walk as a page expression: `walkPage` called with `input` and its helpers. */
export function walkSource(input: WalkInput): string {
  return `(${String(walkPage)})(${JSON.stringify(input)}, ${String(selectorOf)}, ${String(styledOf)})`;
}
