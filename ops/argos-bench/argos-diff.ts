// The one Argos-facing file in this repo (ob 1476). It runs INSIDE the argos-bench container, from
// apps/backend of an unmodified argos-ci/argos checkout, and calls their `diffImages` exactly the
// way their own unit test does (apps/backend/src/screenshot-diff/diff/image/test/diff.test.ts):
// two LocalFileHandle-backed ImageHandles and a threshold. Nothing of theirs is copied here; the
// imports below resolve against their checkout through apps/backend/tsconfig.json's `@/*` path.
//
//   argos-diff <base.png> <head.png> <out-dir> [--threshold 0.5]
//   argos-diff --pairs <dir> <out-dir> [--threshold 0.5]   # <dir>/<name>/{base,head}.png
//
// Prints one JSON object per pair on stdout (JSON Lines), with the time diffImages took in `ms`, and copies Argos's diff image, when it
// makes one, to <out-dir>/<name>.diff.png.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { diffImages } from "@/screenshot-diff/diff/image";
import { ImageHandle, LocalFileHandle } from "@/storage";

type Pair = { name: string; base: string; head: string };

function image(filepath: string) {
  return new ImageHandle({ fileHandle: new LocalFileHandle({ filepath }) });
}

async function run(pair: Pair, outDir: string, threshold: number) {
  const started = performance.now();
  const result = await diffImages(image(pair.base), image(pair.head), { threshold });
  const ms = performance.now() - started;
  let diff: string | null = null;
  if (result.file) {
    diff = join(outDir, `${pair.name}.diff.png`);
    await copyFile(result.file.path, diff);
  }
  return {
    name: pair.name,
    // Argos's own reading: a score of 0 is "unchanged", anything above it is "changed".
    changed: result.score > 0,
    score: result.score,
    threshold,
    width: result.file?.width ?? null,
    height: result.file?.height ?? null,
    diff,
    // Wall time of diffImages alone (ob 1477): excludes ssh, tar and container start.
    ms: Math.round(ms * 10) / 10,
  };
}

async function pairsIn(dir: string): Promise<Pair[]> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return names.map((name) => ({
    name,
    base: join(dir, name, "base.png"),
    head: join(dir, name, "head.png"),
  }));
}

async function main(argv: string[]) {
  let threshold = 0.5;
  const t = argv.indexOf("--threshold");
  if (t !== -1) {
    threshold = Number(argv[t + 1]);
    argv.splice(t, 2);
  }
  if (!(threshold >= 0 && threshold <= 1)) throw new Error("--threshold must be 0..1");

  let pairs: Pair[];
  let outDir: string;
  if (argv[0] === "--pairs" && argv.length === 3) {
    pairs = await pairsIn(argv[1]!);
    outDir = argv[2]!;
  } else if (argv.length === 3) {
    pairs = [{ name: basename(argv[1]!, ".png"), base: argv[0]!, head: argv[1]! }];
    outDir = argv[2]!;
  } else {
    console.error("usage: argos-diff <base.png> <head.png> <out-dir> [--threshold n]");
    console.error("       argos-diff --pairs <dir> <out-dir> [--threshold n]");
    process.exit(2);
  }

  await mkdir(outDir, { recursive: true });
  for (const pair of pairs) {
    console.log(JSON.stringify(await run(pair, outDir, threshold)));
  }
}

await main(process.argv.slice(2));
