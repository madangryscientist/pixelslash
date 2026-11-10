import type { Page } from "@playwright/test";

/** One piece of text that falls short of WCAG AA, with the number that says so. */
export type Shortfall = { text: string; selector: string; ratio: number; needed: number };

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

type Link = { background: string; gradient: boolean; picture: boolean };

/** What the browser reports for one drawn text node; the arithmetic happens in Node. */
type Raw = {
  text: string;
  tag: string;
  id: string;
  firstClass: string;
  drawn: boolean;
  color: string;
  opacity: number;
  size: number;
  weight: number;
};

/** The parent element of every text node worth measuring, once each. */
function textParents(): Element[] {
  const out = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (el?.closest("script, style, noscript, .sr-only")) continue;
    if (el && node.textContent?.trim()) out.add(el);
  }
  return [...out];
}

/** The styles that decide each element's contrast. No arithmetic here. */
function describe(els: Element[]): Raw[] {
  return els.map((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? "").trim().slice(0, 40),
      tag: el.tagName.toLowerCase(),
      id: el.id,
      firstClass: (el.getAttribute("class") ?? "").split(/\s+/)[0] ?? "",
      drawn:
        style.visibility !== "hidden" && style.display !== "none" && box.width * box.height > 0,
      color: style.color,
      opacity: Number(style.opacity),
      size: Number.parseFloat(style.fontSize),
      weight: Number(style.fontWeight),
    };
  });
}

/** Each element and its ancestors, nearest first, with what could sit behind the text. */
function chains(els: Element[]): Link[][] {
  return els.map((el) => {
    const chain: Link[] = [];
    for (let up: Element | null = el; up; up = up.parentElement) {
      const style = getComputedStyle(up);
      chain.push({
        background: style.backgroundColor,
        gradient: style.backgroundImage !== "none",
        picture: up.tagName === "IMG" || up.classList.contains("home-demo"),
      });
    }
    return chain;
  });
}

/** Any CSS colour (color-mix, oklab, hex) to rgba, by drawing it on a canvas. */
function toRgba(colours: string[]): Rgba[] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas");
  return colours.map((css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  });
}

function over(top: Rgba, below: Rgb): Rgb {
  const a = top[3];
  return [
    top[0] * a + below[0] * (1 - a),
    top[1] * a + below[1] * (1 - a),
    top[2] * a + below[2] * (1 - a),
  ];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** The WCAG 2.x contrast ratio between two opaque colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The colour under an element: its ancestors' backgrounds composited from the nearest opaque one
 * down. A picture or a gradient fill has no single colour, so it returns null.
 */
function groundOf(chain: Link[], rgba: Map<string, Rgba>): Rgb | null {
  const layers: Rgba[] = [];
  for (const link of chain) {
    if (link.picture || link.gradient) return null;
    const colour = rgba.get(link.background) ?? [0, 0, 0, 0];
    if (colour[3] > 0) layers.push(colour);
    if (colour[3] === 1) break;
  }
  let base: Rgb = [255, 255, 255];
  for (const layer of layers.toReversed()) base = over(layer, base);
  return base;
}

function shortfall(
  item: Raw,
  chain: Link[],
  rgba: Map<string, Rgba>,
  margin: number,
): Shortfall | null {
  const fg = rgba.get(item.color) ?? [0, 0, 0, 0];
  if (fg[3] === 0) return null; // gradient text
  const bg = groundOf(chain, rgba);
  if (!bg) return null;
  const flat = over([fg[0], fg[1], fg[2], fg[3] * item.opacity], bg);
  const ratio = contrastRatio(flat, bg);
  const large = item.size >= 24 || (item.weight >= 700 && item.size >= 18.66);
  const needed = large ? 3 : 4.5;
  if (ratio >= needed + margin) return null;
  return {
    text: item.text,
    selector: `${item.tag}${item.id ? `#${item.id}` : ""}${item.firstClass ? `.${item.firstClass}` : ""}`,
    ratio: Math.round(ratio * 100) / 100,
    needed,
  };
}

/**
 * Every visible text node's contrast ratio against the colour it sits on (WCAG 2.x relative
 * luminance), measured from computed styles so it follows the theme and any colour-mix. Text on a
 * picture (the hero demo), on a gradient fill, and gradient-filled text (transparent fill) have no
 * single colour to measure against and are left out; aria-hidden text is measured, since it is
 * still drawn. Large text (24px, or 18.66px bold) needs 3, the rest 4.5. `margin` is added to the
 * need, to ask for more than AA.
 */
export async function textBelowAA(page: Page, margin = 0): Promise<Shortfall[]> {
  const els = await page.evaluateHandle(textParents);
  const raw = await els.evaluate(describe);
  const links = await els.evaluate(chains);
  await els.dispose();
  const colours = [
    ...new Set([...raw.map((item) => item.color), ...links.flat().map((l) => l.background)]),
  ];
  const resolved = await page.evaluate(toRgba, colours);
  const rgba = new Map<string, Rgba>();
  for (const [index, css] of colours.entries()) rgba.set(css, resolved[index] ?? [0, 0, 0, 0]);
  return raw.flatMap((item, index) => {
    const found = item.drawn ? shortfall(item, links[index] ?? [], rgba, margin) : null;
    return found ?? [];
  });
}

type Area = { x: number; y: number; w: number; h: number };

/** The text colour and box of the first matches of a selector. */
function textBoxes(selector: string): (Area & { color: string })[] {
  return [...document.querySelectorAll(selector)].slice(0, 3).map((el) => {
    const box = el.getBoundingClientRect();
    return { color: getComputedStyle(el).color, x: box.x, y: box.y, w: box.width, h: box.height };
  });
}

/** Distinct colours (6 bits a channel, packed) of a screenshot inside a box, decoded in the page. */
async function coloursIn(args: { data: string; area: Area }): Promise<number[]> {
  const blob = await (await fetch(`data:image/png;base64,${args.data}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas");
  ctx.drawImage(bitmap, 0, 0);
  const { x, y, w, h } = args.area;
  const pixels = ctx.getImageData(Math.floor(x), Math.floor(y), Math.ceil(w), Math.ceil(h)).data;
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) {
    const [r = 0, g = 0, b = 0] = pixels.slice(i, i + 3);
    seen.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
  }
  return [...seen];
}

/**
 * The lowest contrast, over the pixels actually drawn behind each match of `selector` (its text
 * made invisible first), so the aurora and grid behind an inner page's heading count. Per match:
 * its own colour against the worst background pixel in its box. Pixels are read to 6 bits a channel.
 */
export async function worstOverArt(page: Page, selector: string): Promise<number[]> {
  const boxes = await page.evaluate(textBoxes, selector);
  const inks = await page.evaluate(
    toRgba,
    boxes.map((box) => box.color),
  );
  await page.addStyleTag({
    content: `${selector}, ${selector} * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`,
  });
  const data = (await page.screenshot({ scale: "css" })).toString("base64");
  const worst: number[] = [];
  for (const [index, area] of boxes.entries()) {
    const [r = 0, g = 0, b = 0] = inks[index] ?? [];
    const ink = luminance([r, g, b]);
    let low = Number.POSITIVE_INFINITY;
    for (const packed of await page.evaluate(coloursIn, { data, area })) {
      const back = luminance([(packed >> 12) << 2, ((packed >> 6) & 63) << 2, (packed & 63) << 2]);
      low = Math.min(low, (Math.max(ink, back) + 0.05) / (Math.min(ink, back) + 0.05));
    }
    worst.push(Math.round(low * 100) / 100);
  }
  return worst;
}
