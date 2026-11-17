// Shoots the homepage's demo with the real CLI: hero/page.html as Main, the same page with
// ?branch as Branch. Keeps the two shots and what the run measured, so the homepage quotes a run
// rather than a mock-up. Rerun it after changing hero/page.html: `bun scripts/hero.ts` in apps/site.
// `--out <dir>` writes into <dir>/public/hero and <dir>/src/content instead (site-images.ts).
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, measured, outDir, pixelslash, pngSize, site } from "./cli-run.ts";

const dest = outDir();
const page = await readFile(join(site, "hero/page.html"));
const server = Bun.serve({
  port: 0,
  fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
});
const out = await mkdtemp(join(tmpdir(), "ps-hero-"));
try {
  const base = `http://localhost:${server.port}/`;
  const manifest = await pixelslash(["--live", base, "--local", `${base}?branch`], out);
  await mkdir(join(dest, "public/hero"), { recursive: true });
  for (const shot of ["main.png", "branch.png"]) {
    await cp(join(out, shot), join(dest, "public/hero", shot));
  }
  const result = measured(await pngSize(join(out, "main.png")), manifest);
  await mkdir(join(dest, "src/content"), { recursive: true });
  await writeFile(join(dest, "src/content/hero.json"), json(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await server.stop(true);
  await rm(out, { recursive: true, force: true });
}
