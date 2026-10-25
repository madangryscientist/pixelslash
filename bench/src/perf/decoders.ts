#!/usr/bin/env bun
/**
 * `bun run bench:decoders` (PS-168): every PNG decoder the C# engine can run, timed against each
 * other by `bench:perf --impl`, and the table written to `bench/results/decoders-<yyyy-mm>.md`.
 * Only the C# engine has a decoder to choose: the JS engine (`diff.wasm`) decodes inside its own
 * diff, so the TS rows and their overlay encoders went in PS-211 with the pngjs and napi-image engines.
 *
 *   bun bench/src/perf/decoders.ts [--runs <n>] [--env none|dedicated] [--only <step,...>]
 *
 * It builds what it times first: the C# engine with every candidate compiled in
 * (`-p:DecoderCandidates=true`, into native/out/candidates). The `bun build --compile` start-up row
 * went in PS-210: a compiled binary does not carry `diff.wasm`, which the engine reads from disk.
 * The native libraries come from `native/build.sh`, which fetches sources and so is not run from
 * here; a candidate whose library is missing is a "could not build" row with the reason, not a
 * failure. On demand only, like `bench:perf`: never in the gate.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { say, warn } from "../say.ts";
import { isDump, PAGES, render, type Candidate } from "./decoders-render.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOTNET = join(ROOT, "engines/dotnet");
const NATIVE_OUT = join(DOTNET, "native/out");
const CANDIDATES_DIR = join(NATIVE_OUT, "candidates");
const CSHARP_BIN = join(CANDIDATES_DIR, "PixelSlash.Diff");

type CsDecoder = {
  name: string;
  licence: string;
  weight: string[];
  never?: string;
  library?: string;
};

/** The C# decoders, in `Decoders.Names` order. Licences are of what is linked in. */
const CS_DECODERS: CsDecoder[] = [
  { name: "stb", licence: "Unlicense or MIT (StbImageSharp)", weight: ["StbImageSharp.dll"] },
  {
    name: "spng",
    licence: "BSD-2-Clause (libspng) + zlib (system zlib)",
    weight: ["../libspng-zlib.so"],
    library: "libspng-zlib.so",
  },
  {
    name: "spng-zlibng",
    licence: "BSD-2-Clause (libspng) + zlib (zlib-ng, static)",
    weight: ["../libspng-zlibng.so"],
    library: "libspng-zlibng.so",
  },
  {
    name: "wuffs",
    licence: "Apache-2.0 or MIT (Wuffs)",
    weight: ["../libwuffs-png.so"],
    library: "libwuffs-png.so",
  },
  {
    name: "skia",
    licence: "MIT (SkiaSharp) + BSD-3-Clause (Skia)",
    weight: ["SkiaSharp.dll", "runtimes/linux-x64/native"],
  },
  {
    name: "imagesharp",
    licence: "Six Labors Split License 1.0 (3.1.12)",
    weight: ["SixLabors.ImageSharp.dll"],
    never:
      "Six Labors Split: a paid licence for commercial use over $1M revenue; 3.2+ needs a key to build",
  },
];

function csRows(): Candidate[] {
  return CS_DECODERS.flatMap((d) =>
    (d.name === "stb" ? ["sequential", "parallel"] : ["parallel"]).map((mode): Candidate => ({
      label: `${d.name} ${mode}`,
      command: `${CSHARP_BIN} --decoder ${d.name} --decode ${mode}`,
      licence: d.licence,
      weight: d.weight.map((w) => join(CANDIDATES_DIR, w)),
      ...(d.never ? { never: d.never } : {}),
      ...(d.library && !existsSync(join(NATIVE_OUT, d.library))
        ? { missing: `${d.library} is not built (engines/dotnet/native/build.sh)` }
        : {}),
    })),
  );
}

/** Every row the table has, measurable or not. Pure: what is on disk only decides `missing`. */
export function candidates(): Candidate[] {
  return csRows();
}

async function sh(argv: string[], cwd = ROOT): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
}

async function build(): Promise<void> {
  warn("decoders: building the C# engine with every candidate");
  await sh([
    "dotnet",
    "build",
    join(DOTNET, "PixelSlash.Diff"),
    "-c",
    "Release",
    "-p:DecoderCandidates=true",
    "-o",
    CANDIDATES_DIR,
    "--nologo",
    "-v",
    "q",
  ]);
}

async function main(argv: string[]): Promise<number> {
  await build();
  const rows = candidates();
  const timed = rows.filter((r) => !r.missing);
  for (const r of rows.filter((x) => x.missing)) warn(`decoders: ${r.label}: ${r.missing}`);
  const perf = Bun.spawn(
    [
      "bun",
      join(ROOT, "bench/src/perf/run.ts"),
      ...timed.flatMap((r) => ["--impl", r.command]),
      "--only",
      PAGES.join(","),
      ...argv,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "inherit" },
  );
  const text = await new Response(perf.stdout).text();
  process.stdout.write(text);
  // Exit 1 from the runner is a candidate that failed a step; its row says so. Anything else is ours.
  const code = await perf.exited;
  const numbers = /^numbers: (.+)$/m.exec(text)?.[1];
  if (!numbers || (code !== 0 && code !== 1)) {
    warn(`decoders: bench:perf exited ${code} without numbers`);
    return 2;
  }
  const dump: unknown = JSON.parse(readFileSync(numbers, "utf8"));
  if (!isDump(dump)) {
    warn(`decoders: ${numbers} is not a bench:perf numbers file`);
    return 2;
  }
  // The runner's stdout opens with its environment header, up to the `perf:` line.
  const lines = text.split("\n");
  const header = lines
    .slice(
      0,
      Math.max(
        0,
        lines.findIndex((l) => l.startsWith("perf:")),
      ),
    )
    .filter((l) => l !== "");
  const date = new Date().toISOString().slice(0, 7);
  const file = join(ROOT, "bench/results", `decoders-${date}.md`);
  writeFileSync(file, render(rows, dump.impls, header, new Date().toISOString().slice(0, 10)));
  say(`table: ${file}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
