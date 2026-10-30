import { settleCapture } from "@hackcove/pixelslash-engine";
import { chromium } from "playwright";

const WARMUP = 1;
const ITERATIONS = 3;

const HTML = `<!doctype html><meta charset="utf-8"><title>perf</title>
<style>body{font:16px sans-serif;margin:0}main{max-width:720px;margin:0 auto;padding:24px}
section{border:1px solid #cbd5e1;border-radius:8px;margin:16px 0;padding:16px}
img{display:block;width:100%;height:160px;background:#e2e8f0}</style>
<main>${Array.from(
  { length: 12 },
  (_, i) =>
    `<section><h2>Card ${i}</h2><p>${"Lorem ipsum dolor sit amet. ".repeat(8)}</p><img src="/hero-${i % 3}.svg" alt=""></section>`,
).join("")}</main>`;

const SVG = (hue: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="160"><rect width="720" height="160" fill="hsl(${hue} 60% 70%)"/></svg>`;

/** A fixed static page served by this process, shot with the engine's real settle path. */
export async function timeCapture(): Promise<number[]> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const svg = /^\/hero-(\d)\.svg$/.exec(path);
      if (svg) {
        return new Response(SVG(Number(svg[1]) * 90), {
          headers: { "content-type": "image/svg+xml" },
        });
      }
      return new Response(HTML, { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await chromium.launch({
    headless: true,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
      const started = performance.now();
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(`http://localhost:${server.port}/`, { waitUntil: "domcontentloaded" });
        await settleCapture(page);
        await page.screenshot({ fullPage: true });
      } finally {
        await page.close();
      }
      if (i >= WARMUP) samples.push(performance.now() - started);
    }
    return samples;
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
