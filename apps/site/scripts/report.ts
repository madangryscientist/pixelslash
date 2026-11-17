// Shoots public/report.png, the review app's compare view of one changed shot, from a real run: the
// CLI captures fixtures/pages/live.html as Main and fixtures/pages/local.html as Branch, then
// apps/web/e2e/site-report.shoot.ts uploads those two shots to a local e2e build of the review app
// (never a hosted server) and screenshots the compare view. Keeps what the run measured in
// src/content/report.json. Rerun it after a change to the review screen: `bun scripts/report.ts` in
// apps/site. `--out <dir>` writes into <dir>/public and <dir>/src/content instead (site-images.ts).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await shootReviewApp(
    join(out, "main.png"),
    join(out, "local.png"),
    manifest.changedPixels,
    join(dest, "public/report.png"),
  );
  const result = measured(await pngSize(join(out, "main.png")), manifest);
  await mkdir(join(dest, "src/content"), { recursive: true });
  await writeFile(join(dest, "src/content/report.json"), json(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await server.stop(true);
  await rm(out, { recursive: true, force: true });
}

/**
 * Runs the review app's site-report shoot (apps/web) on these two shots, saving the page to `to`. The
 * shoot fails unless the app's diff counts the same `changedPixels` as the CLI run.
 */
async function shootReviewApp(
  mainPng: string,
  branchPng: string,
  changedPixels: number,
  to: string,
): Promise<void> {
  const run = Bun.spawn(["bunx", "playwright", "test", "-c", "playwright.site-report.config.ts"], {
    cwd: join(site, "../web"),
    env: {
      ...process.env,
      PIXELSLASH_SITE_REPORT_MAIN: mainPng,
      PIXELSLASH_SITE_REPORT_BRANCH: branchPng,
      PIXELSLASH_SITE_REPORT_CHANGED_PIXELS: String(changedPixels),
      PIXELSLASH_SITE_REPORT_OUT: to,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await run.exited) !== 0) throw new Error(`the review app shoot exited ${run.exitCode}`);
}
