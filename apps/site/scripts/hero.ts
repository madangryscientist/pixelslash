// Shoots the homepage's demo with the real CLI: hero/page.html as Main, the same page with
// ?branch as Branch. Keeps the two shots and what the run measured, so the homepage quotes a run
// rather than a mock-up. Rerun it after changing hero/page.html: `bun scripts/hero.ts` in apps/site.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = join(import.meta.dir, "..");
const page = await readFile(join(site, "hero/page.html"));
const server = Bun.serve({
  port: 0,
  fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
});
const out = await mkdtemp(join(tmpdir(), "ps-hero-"));
try {
  const base = `http://localhost:${server.port}/`;
  // Not spawnSync: that would block this process's server while the CLI shoots it.
  const run = Bun.spawn(
    ["bun", "run", "pixelslash", "--", "--live", base, "--local", `${base}?branch`, "--out", out],
    { cwd: join(site, "../.."), stdout: "inherit", stderr: "inherit" },
  );
  if ((await run.exited) !== 0) throw new Error(`pixelslash exited ${run.exitCode}`);
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  await mkdir(join(site, "public/hero"), { recursive: true });
  for (const shot of ["main.png", "branch.png"]) {
    await cp(join(out, shot), join(site, "public/hero", shot));
  }
  const { width, height } = await Bun.file(join(out, "main.png"))
    .bytes()
    .then((b) => ({
      width: new DataView(b.buffer).getUint32(16),
      height: new DataView(b.buffer).getUint32(20),
    }));
  const measured = {
    width,
    height,
    changedPixels: manifest.changedPixels,
    regions: manifest.regions.map(
      (r: {
        x: number;
        y: number;
        w: number;
        h: number;
        changedPixels: number;
        kind?: string;
      }) => ({
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        changedPixels: r.changedPixels,
        kind: r.kind,
      }),
    ),
    createdAt: manifest.createdAt,
  };
  await writeFile(join(site, "src/content/hero.json"), `${JSON.stringify(measured, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(measured)}\n`);
} finally {
  await server.stop(true);
  await rm(out, { recursive: true, force: true });
}
