// Draws public/social-card.png, the 1200x630 image a shared link shows: the home's headline beside
// the demo's real Branch shot. Rerun after changing the headline or the shot:
// `bun scripts/social-card.ts` in apps/site.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const site = join(import.meta.dir, "..");
const dataUrl = async (path: string, type: string): Promise<string> =>
  `data:${type};base64,${(await readFile(join(site, path))).toString("base64")}`;

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(${await dataUrl("public/fonts/inter-latin-wght-normal.woff2", "font/woff2")}); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; background: #1e1e2e; color: #cdd6f4; font-family: Inter; position: relative; }
.glow { position: absolute; inset: 0; background: radial-gradient(600px 420px at 8% 0%, #cba6f733, transparent), radial-gradient(640px 460px at 100% 100%, #89b4fa33, transparent); }
.copy { position: absolute; left: 64px; top: 64px; bottom: 64px; width: 560px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 32px; font-weight: 700; }
.brand img { width: 56px; height: 56px; }
h1 { margin-top: auto; font-size: 68px; line-height: 1.06; letter-spacing: -0.02em; font-weight: 800; }
h1 span { color: #cba6f7; }
p { margin-top: 28px; font-size: 26px; color: #bac2de; }
.shot { position: absolute; left: 672px; top: 64px; width: 640px; border-radius: 14px; border: 1px solid #45475a; box-shadow: 0 24px 64px #11111b; }
</style>
<div class="glow"></div>
<div class="copy">
  <div class="brand"><img src="${await dataUrl("public/favicon.svg", "image/svg+xml")}" alt="">PixelSlash</div>
  <h1>See what your change <span>did to the page.</span></h1>
  <p>Open source · MIT · Local first</p>
</div>
<img class="shot" src="${await dataUrl("public/hero/branch.png", "image/png")}" alt="">`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(site, "public/social-card.png") });
} finally {
  await browser.close();
}
