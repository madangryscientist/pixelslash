#!/usr/bin/env bun
/**
 * Render the corpus (ob 1477): `bun bench/src/generate.ts`. Each case in cases.ts is rendered from
 * the fixture pages in bench/fixtures/ with Playwright's Chromium, and written to bench/corpus/.
 * The PNGs are committed, so the benchmark itself does not need a browser; re-run this only to
 * change the corpus. It fails if an `identical` pair differs or a `noise`/`real` pair does not.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import { CASES, type CaseDef, type Dither, type Variant } from "./cases.ts";
import { BENCH_DIR, CORPUS_DIR, type CaseLabel } from "./corpus.ts";
import type { Rect } from "./regions.ts";
import { say, warn } from "./say.ts";

/** Tall enough that the whole page is in view, short enough that an appended section makes it grow. */
const VIEWPORTS = {
  dashboard: { width: 640, height: 480 },
  form: { width: 640, height: 460 },
  article: { width: 640, height: 640 },
  pages: { width: 1280, height: 720 },
};
const FONTCONFIGS = join(BENCH_DIR, "fixtures", "fontconfig");
const PAGES = join(BENCH_DIR, "fixtures");
const REPO = join(BENCH_DIR, "..");

declare const document: {
  fonts: { ready: Promise<unknown> };
  querySelectorAll(selector: string): ArrayLike<{
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  }>;
  createRange(): {
    selectNodeContents(node: unknown): void;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  };
};
declare function requestAnimationFrame(callback: () => void): number;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyDither(png: Buffer, d: Dither): Buffer {
  const img = PNG.sync.read(png);
  const rand = mulberry32(d.seed);
  for (let i = 0; i < img.data.length; i += 4) {
    if (rand() >= d.density) continue;
    for (let c = 0; c < 3; c++) {
      const delta = (rand() < 0.5 ? -1 : 1) * d.amp;
      img.data[i + c] = Math.max(0, Math.min(255, (img.data[i + c] ?? 0) + delta));
    }
  }
  return PNG.sync.write(img);
}

type Size = { width: number; height: number };

async function roundTripJpeg(
  browser: Browser,
  page: Page,
  jpeg: { quality: number; fullPage: boolean; viewport: Size },
) {
  const bytes = await page.screenshot({
    type: "jpeg",
    quality: jpeg.quality,
    fullPage: jpeg.fullPage,
  });
  const helper = await browser.newPage({ viewport: jpeg.viewport });
  try {
    await helper.setContent(
      `<body style="margin:0"><img id="i" src="data:image/jpeg;base64,${bytes.toString("base64")}"></body>`,
    );
    await helper.waitForFunction(() => document.fonts.ready);
    await helper.waitForTimeout(100);
    return await helper.screenshot({ type: "png", fullPage: true });
  } finally {
    await helper.close();
  }
}

type Render = { png: Buffer; rects: Rect[] };

async function launch(browsers: Map<string, Browser>, v: Variant): Promise<Browser> {
  const key = `${(v.args ?? []).join(" ")}|${v.fontconfig ?? ""}`;
  const known = browsers.get(key);
  if (known) return known;
  const env = v.fontconfig
    ? { ...process.env, FONTCONFIG_FILE: join(FONTCONFIGS, `${v.fontconfig}.conf`) }
    : process.env;
  const browser = await chromium.launch({ headless: true, args: v.args ?? [], env });
  browsers.set(key, browser);
  return browser;
}

/** Fonts loaded and two frames drawn, so the shot is of a settled page. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // Styles injected after load repaint on tile threads; without a pause a shot can catch half of it.
  await page.waitForTimeout(150);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function measure(page: Page, entries: string[]): Promise<Rect[]> {
  return page.evaluate((sels) => {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const entry of sels) {
      const text = entry.startsWith("text:");
      for (const el of Array.from(document.querySelectorAll(text ? entry.slice(5) : entry))) {
        let r = el.getBoundingClientRect();
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(el);
          r = range.getBoundingClientRect();
        }
        if (r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
    }
    return out;
  }, entries);
}

async function render(browsers: Map<string, Browser>, def: CaseDef, v: Variant): Promise<Render> {
  const browser = await launch(browsers, v);
  const viewport = VIEWPORTS[def.page];
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    const file = v.source ? join(REPO, v.source) : join(PAGES, `${def.page}.html`);
    await page.goto(`file://${file}`);
    if (v.css) await page.addStyleTag({ content: v.css });
    if (v.js) await page.evaluate(v.js);
    await settle(page);
    const rects = await measure(page, def.box ?? []);
    const fullPage = def.fullPage === true;
    const png =
      v.jpeg === undefined
        ? await page.screenshot({ type: "png", fullPage })
        : await roundTripJpeg(browser, page, { quality: v.jpeg, fullPage, viewport });
    return { png: v.dither ? applyDither(png, v.dither) : png, rects };
  } finally {
    await page.close();
  }
}

function union(rects: Rect[], width: number, height: number): Rect {
  if (rects.length === 0) throw new Error("box selectors matched nothing");
  const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y))));
  const x1 = Math.min(width, Math.ceil(Math.max(...rects.map((r) => r.x + r.w))));
  const y1 = Math.min(height, Math.ceil(Math.max(...rects.map((r) => r.y + r.h))));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function samePixels(a: Buffer, b: Buffer): boolean {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  return pa.width === pb.width && pa.height === pb.height && pa.data.equals(pb.data);
}

function labelFor(def: CaseDef, base: Render, head: Render): CaseLabel {
  const a = PNG.sync.read(base.png);
  const b = PNG.sync.read(head.png);
  const label: CaseLabel = {
    label: def.label,
    kind: def.kind,
    page: def.page,
    width: b.width,
    height: b.height,
  };
  if (def.label === "real") {
    const rects = [...base.rects, ...head.rects];
    label.box = union(rects, Math.max(a.width, b.width), Math.max(a.height, b.height));
  }
  return label;
}

/** Whether the pair's pixels match what the label promises; a message when they do not. */
function check(def: CaseDef, base: Render, head: Render): string | null {
  const equal = samePixels(base.png, head.png);
  if (def.label === "identical" && !equal) return `${def.name}: should be identical`;
  if (def.label !== "identical" && equal) return `${def.name}: the pair does not differ`;
  return null;
}

function writeCase(def: CaseDef, base: Render, head: Render): void {
  const dir = join(CORPUS_DIR, def.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "base.png"), base.png);
  writeFileSync(join(dir, "head.png"), head.png);
  writeFileSync(join(dir, "label.json"), `${JSON.stringify(labelFor(def, base, head), null, 2)}\n`);
}

function pruneStale(): void {
  const keep = new Set(CASES.map((c) => c.name));
  for (const dir of readdirSync(CORPUS_DIR)) {
    if (!keep.has(dir)) rmSync(join(CORPUS_DIR, dir), { recursive: true, force: true });
  }
}

async function main() {
  const only = process.argv.slice(2);
  const defs = only.length > 0 ? CASES.filter((c) => only.some((o) => c.name.includes(o))) : CASES;
  const browsers = new Map<string, Browser>();
  const problems: string[] = [];
  mkdirSync(CORPUS_DIR, { recursive: true });
  if (only.length === 0) pruneStale();
  try {
    for (const def of defs) {
      const base = await render(browsers, def, def.base);
      const head = await render(browsers, def, def.head);
      const problem = check(def, base, head);
      if (problem) problems.push(problem);
      writeCase(def, base, head);
      say(`${def.label.padEnd(9)} ${def.name}`);
    }
  } finally {
    await Promise.all([...browsers.values()].map((b) => b.close()));
  }
  if (problems.length > 0) {
    warn(`\n${problems.join("\n")}`);
    process.exit(1);
  }
}

await main();
