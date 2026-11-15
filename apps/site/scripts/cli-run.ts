// What hero.ts, report.ts and site-images.ts share: the `--out` flag, a run of the real CLI, the size
// of a PNG and the measured form of a run's manifest. Each script is still run on its own.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const site = join(import.meta.dir, "..");
const repo = join(site, "../..");

/**
 * The dir a script writes into, laid out like apps/site: PNGs under `public/`, JSON under
 * `src/content/`. `--out <dir>` names it; without the flag it is apps/site itself.
 */
export function outDir(argv: string[] = process.argv.slice(2)): string {
  const at = argv.indexOf("--out");
  if (at === -1) return site;
  const dir = argv[at + 1];
  if (!dir || dir.startsWith("--")) throw new Error("--out needs a directory");
  return dir;
}

type Region = { x: number; y: number; w: number; h: number; changedPixels: number; kind?: string };
export type Manifest = { changedPixels: number; regions: Region[] };

/** Runs `pixelslash <args>` from the repo root and returns the `manifest.json` it wrote to `out`. */
export async function pixelslash(args: string[], out: string): Promise<Manifest> {
  // Not spawnSync: that would block a server in this process while the CLI shoots it.
  const run = Bun.spawn(["bun", "run", "pixelslash", "--", ...args, "--out", out], {
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await run.exited) !== 0) throw new Error(`pixelslash exited ${run.exitCode}`);
  const manifest: Manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  return manifest;
}

/** A PNG's width and height, read from its IHDR chunk. */
export async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const b = await Bun.file(path).bytes();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** What a run measured, as the site's JSON files keep it: no timestamp, so a rerun that saw the same writes the same bytes. */
export function measured(size: { width: number; height: number }, manifest: Manifest) {
  return {
    ...size,
    changedPixels: manifest.changedPixels,
    regions: manifest.regions.map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      changedPixels: r.changedPixels,
      kind: r.kind,
    })),
  };
}

export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
