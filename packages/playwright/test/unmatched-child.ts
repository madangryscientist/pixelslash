// Run by snapshot.spec.ts in a child process (PS-241): a worker is one process, and its tally of the
// selectors that matched nothing prints when the process exits, so the spec reads that from stderr.
// argv: the ignore selector, then one page body per shot. PIXELSLASH_SNAPSHOT_DIR is the dir.
import { chromium } from "playwright";
import { snapshot } from "../src/index.ts";

const [selector = "", ...bodies] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [i, body] of bodies.entries()) {
    await page.setContent(body);
    await snapshot(page, `shot-${i}`, { ignore: [selector] });
  }
} finally {
  await browser.close();
}
