// Shoots public/report.png, the report a run writes, with the real CLI: fixtures/pages/live.html as
// Main and fixtures/pages/local.html as Branch. The Timings table is hidden, since its milliseconds
// change on every run. Keeps what the run measured in src/content/report.json. Rerun it after a
// change to the report: `bun scripts/report.ts` in apps/site. `--out <dir>` writes into
// <dir>/public and <dir>/src/content instead (site-images.ts).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { json, measured, outDir, pixelslash, pngSize, site } from "./cli-run.ts";

const dest = outDir();
const pages = join(site, "../../fixtures/pages");
const main = await readFile(join(pages, "live.html"));
const branch = await readFile(join(pages, "local.html"));
const server = Bun.serve({
  port: 0,
  fetch: (req) =>
    new Response(new URL(req.url).pathname === "/branch" ? branch : main, {
      headers: { "content-type": "text/html" },
    }),
});
const out = await mkdtemp(join(tmpdir(), "ps-report-"));
try {
  const base = `http://localhost:${server.port}`;
  const manifest = await pixelslash(["--live", `${base}/main`, "--local", `${base}/branch`], out);
  await mkdir(join(dest, "public"), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 960 },
      deviceScaleFactor: 2,
    });
    await page.goto(pathToFileURL(join(out, "report.html")).href, { waitUntil: "load" });
    await page.addStyleTag({ content: "section.timings { display: none !important; }" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({ path: join(dest, "public/report.png") });
  } finally {
    await browser.close();
  }
  const result = measured(await pngSize(join(out, "main.png")), manifest);
  await mkdir(join(dest, "src/content"), { recursive: true });
  await writeFile(join(dest, "src/content/report.json"), json(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await server.stop(true);
  await rm(out, { recursive: true, force: true });
}
