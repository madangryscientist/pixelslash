import type { Page } from "playwright";
import {
  MAX_METRICS_PARTS,
  MAX_PART_NAME,
  METRICS_VERSION,
  round2,
  uniqueNames,
  type Metrics,
  type MetricsPart,
} from "./metrics-entry.ts";

/**
 * The web emitter of the layout metrics file (PS-294, `docs/metrics.md`): every `[data-part]`
 * element's box and computed style on the settled page, at the moment of the shot. `capture` and
 * `@hackcove/pixelslash-playwright` both read through here. The page read is dumb (strings as the
 * browser reports them) and the conversion is plain code, so it runs under Node and Bun alike.
 */

/** The attribute that names a part. */
export const PART_ATTRIBUTE = "data-part";

/** What the page gives back for one element, before it is turned into a part. */
export type RawPart = {
  name: string;
  rect: { left: number; top: number; width: number; height: number };
  padding: [string, string, string, string];
  display: string;
  flexDirection: string;
  rowGap: string;
  columnGap: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  color: string;
  background: string;
  borderColor: string;
  borderWidth: string;
  borderStyle: string;
  /** The element has text of its own (a text node child that is not whitespace). */
  text: boolean;
};

/** Browser globals the read touches (the tsconfig has no DOM lib). Type-only. */
type Style = { getPropertyValue(p: string): string; display: string };
type Node_ = { nodeType: number; textContent: string | null };
type PartEl = {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  checkVisibility?(options: { visibilityProperty: boolean }): boolean;
  childNodes: ArrayLike<Node_>;
};
declare const getComputedStyle: (el: PartEl) => Style;

/** Runs in the page, so it touches only its argument and the browser's globals. */
function readParts(elements: PartEl[], attribute: string): RawPart[] {
  const out: RawPart[] = [];
  for (const el of elements) {
    const cs = getComputedStyle(el);
    const display = cs.display;
    if (display === "contents" || el.checkVisibility?.({ visibilityProperty: true }) === false)
      continue;
    const r = el.getBoundingClientRect();
    const read = (p: string) => cs.getPropertyValue(p).trim();
    out.push({
      name: el.getAttribute(attribute) ?? "",
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      padding: [
        read("padding-top"),
        read("padding-right"),
        read("padding-bottom"),
        read("padding-left"),
      ],
      display,
      flexDirection: read("flex-direction"),
      rowGap: read("row-gap"),
      columnGap: read("column-gap"),
      fontSize: read("font-size"),
      fontWeight: read("font-weight"),
      lineHeight: read("line-height"),
      color: read("color"),
      background: read("background-color"),
      borderColor: read("border-top-color"),
      borderWidth: read("border-top-width"),
      borderStyle: read("border-top-style"),
      text: Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
      ),
    });
  }
  return out;
}

const px = (v: string): number | null => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  return m?.[1] === undefined ? null : Number(m[1]);
};

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/**
 * A computed colour as lowercase `#rrggbb` or `#rrggbbaa`; null for transparent and for a form
 * the browser keeps that is not sRGB `rgb()`/`rgba()` (`oklch(…)`, `color(display-p3 …)`), which
 * is left out rather than guessed.
 */
export function hexOf(value: string): string | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(
    value,
  );
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  if (!(alpha > 0)) return null;
  const rgb = `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`;
  return alpha >= 1 ? rgb : `${rgb}${hex2(alpha * 255)}`;
}

function paddingOf(raw: RawPart): MetricsPart["padding"] {
  const [top, right, bottom, left] = raw.padding.map(px);
  if (top == null || right == null || bottom == null || left == null) return undefined;
  return { top: round2(top), right: round2(right), bottom: round2(bottom), left: round2(left) };
}

function gapOf(raw: RawPart): number | undefined {
  if (!/flex|grid/.test(raw.display)) return undefined;
  const gap = px(raw.flexDirection.startsWith("column") ? raw.rowGap : raw.columnGap);
  return gap === null ? undefined : round2(gap);
}

/** The font of an element with text of its own; undefined for one without, or an unreadable one. */
function fontOf(raw: RawPart): MetricsPart["font"] {
  const size = px(raw.fontSize);
  const weight = Number(raw.fontWeight);
  if (!raw.text || size === null || !Number.isFinite(weight) || weight < 1) return undefined;
  const lineHeight = px(raw.lineHeight);
  return {
    size: round2(size),
    weight: round2(weight),
    ...(lineHeight !== null && { lineHeight: round2(lineHeight) }),
  };
}

function colorOf(raw: RawPart, hasFont: boolean): MetricsPart["color"] {
  const fg = hasFont ? hexOf(raw.color) : null;
  const bg = hexOf(raw.background);
  const visible = (px(raw.borderWidth) ?? 0) > 0 && !["none", "hidden"].includes(raw.borderStyle);
  const border = visible ? hexOf(raw.borderColor) : null;
  const color = { ...(fg && { fg }), ...(bg && { bg }), ...(border && { border }) };
  return Object.keys(color).length > 0 ? color : undefined;
}

function partOf(raw: RawPart, origin: { x: number; y: number }): MetricsPart {
  const padding = paddingOf(raw);
  const gap = gapOf(raw);
  const font = fontOf(raw);
  const color = colorOf(raw, font !== undefined);
  return {
    box: {
      x: round2(raw.rect.left - origin.x),
      y: round2(raw.rect.top - origin.y),
      w: round2(raw.rect.width),
      h: round2(raw.rect.height),
    },
    ...(padding && { padding }),
    ...(gap !== undefined && { gap }),
    ...(font && { font }),
    ...(color && { color }),
  };
}

/**
 * The metrics file for raw parts in document order. The first is the root and the origin; null when
 * the page has none. More than `MAX_METRICS_PARTS` throws: a file that quietly lost parts would let a
 * missing part look like one that was never there.
 */
export function buildMetrics(raws: readonly RawPart[]): Metrics | null {
  const [first] = raws;
  if (!first) return null;
  if (raws.length > MAX_METRICS_PARTS)
    throw new Error(
      `the page has ${raws.length} [${PART_ATTRIBUTE}] elements; metrics keep at most ${MAX_METRICS_PARTS}`,
    );
  const named = raws.filter((r) => r.name !== "");
  const [root] = named;
  if (!root) return null;
  const origin = { x: root.rect.left, y: root.rect.top };
  const names = uniqueNames(named.map((r) => r.name.slice(0, MAX_PART_NAME)));
  const parts: Record<string, MetricsPart> = {};
  for (const [i, raw] of named.entries()) parts[names[i] ?? raw.name] = partOf(raw, origin);
  return { version: METRICS_VERSION, root: names[0] ?? root.name, parts };
}

/** Every `[data-part]` element on the live page as the metrics file, or null when it has none. */
export async function measureMetrics(page: Page): Promise<Metrics | null> {
  const raws = await page.locator(`[${PART_ATTRIBUTE}]`).evaluateAll(readParts, PART_ATTRIBUTE);
  return buildMetrics(raws);
}
