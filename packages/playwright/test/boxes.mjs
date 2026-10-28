// Run by snapshot.spec.ts under `node` and under `bun` (PS-237): shoots the fixture page with an
// ignore and a redact selector through the built bundle and prints what the helper decided, as JSON:
// the ignore boxes, the variant, and the redacted pixels' colour. The two runtimes must print the same.
// argv: the URL of the fixture page. PIXELSLASH_SNAPSHOT_DIR is the dir.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { snapshot } from "../dist/index.js";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 640, height: 480 },
    deviceScaleFactor: 2,
  });
  await page.goto(process.argv[2]);
  await page.evaluate(() => window.scrollTo(0, 400));
  const dir = process.env.PIXELSLASH_SNAPSHOT_DIR;
  const entry = await snapshot(page, "watch", { ignore: [".player"], redact: [".secret"], dir });
  const img = PNG.sync.read(await readFile(join(dir, entry.file)));
  const at = (65 * 2 * img.width + 25 * 2) << 2;
  process.stdout.write(
    JSON.stringify({
      ignore: entry.ignore,
      variant: entry.variant,
      file: entry.file,
      width: img.width,
      height: img.height,
      redacted: [...img.data.subarray(at, at + 4)],
    }) + "\n",
  );
} finally {
  await browser.close();
}
