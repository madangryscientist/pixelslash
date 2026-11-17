// Regenerates the four files slashslash.build fetches from this repo (the hero shots, hero.json,
// report.png and report.json) and replaces a committed one only when it really changed: a PNG when
// our own diff, at the CLI's defaults, counts a changed pixel (or the size differs), a JSON file when
// its text differs. Prints what it replaced and exits 0 either way. `--body <file>` also writes that
// list as markdown, for the pull request the site-images workflow opens.
// `bun apps/site/scripts/site-images.ts` from the repo root.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pixelslash, pngSize, site } from "./cli-run.ts";

const PNGS = ["public/hero/main.png", "public/hero/branch.png", "public/report.png"];
const JSONS = ["src/content/hero.json", "src/content/report.json"];

const argv = process.argv.slice(2);
const bodyAt = argv.indexOf("--body");
const bodyFile = bodyAt === -1 ? undefined : argv[bodyAt + 1];

async function generate(script: string, fresh: string): Promise<void> {
  const run = Bun.spawn(["bun", join(import.meta.dir, script), "--out", fresh], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await run.exited) !== 0) throw new Error(`${script} exited ${run.exitCode}`);
}

/** Why the fresh PNG replaces the committed one, or undefined when it does not. */
async function pngChange(committed: string, fresh: string): Promise<string | undefined> {
  if (!(await Bun.file(committed).exists())) return "new file";
  const [a, b] = [await pngSize(committed), await pngSize(fresh)];
  if (a.width !== b.width || a.height !== b.height)
    return `size ${a.width}x${a.height} to ${b.width}x${b.height}`;
  const out = await mkdtemp(join(tmpdir(), "ps-site-images-diff-"));
  try {
    const { changedPixels } = await pixelslash(
      ["--live-png", committed, "--local-png", fresh],
      out,
    );
    return changedPixels > 0 ? `${changedPixels} changed pixels` : undefined;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const fresh = await mkdtemp(join(tmpdir(), "ps-site-images-"));
const changed: { file: string; why: string }[] = [];
try {
  await generate("hero.ts", fresh);
  await generate("report.ts", fresh);
  for (const file of PNGS) {
    const why = await pngChange(join(site, file), join(fresh, file));
    if (why) changed.push({ file, why });
  }
  for (const file of JSONS) {
    const now = await readFile(join(site, file), "utf8").catch(() => undefined);
    if (now !== (await readFile(join(fresh, file), "utf8")))
      changed.push({ file, why: now === undefined ? "new file" : "content changed" });
  }
  for (const { file } of changed) await cp(join(fresh, file), join(site, file));
} finally {
  await rm(fresh, { recursive: true, force: true });
}

const lines = changed.map(({ file, why }) => `- \`apps/site/${file}\`: ${why}`);
process.stdout.write(
  changed.length === 0 ? "site-images: no change\n" : `site-images: changed\n${lines.join("\n")}\n`,
);
if (bodyFile) {
  await writeFile(
    bodyFile,
    `The site images were regenerated from \`main\` by \`apps/site/scripts/site-images.ts\`.\n\n${lines.join("\n")}\n`,
  );
}
