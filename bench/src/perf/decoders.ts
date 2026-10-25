#!/usr/bin/env bun
/**
 * `bun run bench:decoders` (PS-168): every PNG decoder and overlay encoder the two engines can run,
 * timed against each other by `bench:perf --impl`, and the table written to
 * `bench/results/decoders-<yyyy-mm>.md`.
 *
 *   bun bench/src/perf/decoders.ts [--runs <n>] [--env none|dedicated] [--only <step,...>]
 *
 * It builds what it times first: the C# engine with every candidate compiled in
 * (`-p:DecoderCandidates=true`, into native/out/candidates) and the TS impl as one `bun build
 * --compile` binary, for the start-up row. The native libraries come from `native/build.sh`, which
 * fetches sources and so is not run from here; a candidate whose library is missing is a "could not
 * build" row with the reason, not a failure. On demand only, like `bench:perf`: never in the gate.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODECS,
  DECODERS,
  OVERLAYS,
  isDecoder,
  type Codec,
  type DecoderName,
  type OverlayName,
} from "../impl/ts-codecs.ts";
import { say, warn } from "../say.ts";
import { isDump, render, type Candidate } from "./decoders-render.ts";
import { CACHE_ROOT } from "./worktree.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOTNET = join(ROOT, "engines/dotnet");
const NATIVE_OUT = join(DOTNET, "native/out");
const CANDIDATES_DIR = join(NATIVE_OUT, "candidates");
const CSHARP_BIN = join(CANDIDATES_DIR, "PixelSlash.Diff");
const TS_DIFF = join(ROOT, "bench/src/impl/ts-diff.ts");
const COMPILED = join(CACHE_ROOT, "ts-diff-compiled", "ts-diff");

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

/** The installed size of an npm package, wherever the isolated linker put it. */
function packageDirs(name: string): string[] {
  const store = join(ROOT, "node_modules/.bun");
  if (!existsSync(store)) return [];
  if (name === "@img") {
    return readdirSync(store)
      .filter((d) => d.startsWith("@img+"))
      .flatMap((d) => {
        const scope = join(store, d, "node_modules/@img");
        return existsSync(scope) ? readdirSync(scope).map((p) => join(scope, p)) : [];
      });
  }
  const prefix = `${name.replace("/", "+")}@`;
  return readdirSync(store)
    .filter((d) => d.startsWith(prefix))
    .map((d) => join(store, d, "node_modules", name))
    .filter((p) => existsSync(p));
}

const tsWeight = (packages: string[]): string[] => [...new Set(packages.flatMap(packageDirs))];

function csRows(): Candidate[] {
  return CS_DECODERS.flatMap((d) =>
    (d.name === "stb" ? ["sequential", "parallel"] : ["parallel"]).map((mode): Candidate => ({
      label: `${d.name} ${mode}`,
      engine: "C#",
      kind: "decoder",
      command: `${CSHARP_BIN} --decoder ${d.name} --decode ${mode}`,
      licence: d.licence,
      workerd: false,
      cli: false,
      csharp: true,
      weight: d.weight.map((w) => join(CANDIDATES_DIR, w)),
      ...(d.never ? { never: d.never } : {}),
      ...(d.library && !existsSync(join(NATIVE_OUT, d.library))
        ? { missing: `${d.library} is not built (engines/dotnet/native/build.sh)` }
        : {}),
    })),
  );
}

const tsCommand = (decoder: DecoderName, mode: string, overlay: OverlayName): string =>
  `bun ${TS_DIFF} --decoder ${decoder} --decode ${mode} --overlay ${overlay}`;

/** A TS row's licence and reach, from the codec it loads. */
function tsRow(codec: Codec): Omit<Candidate, "label" | "engine" | "kind" | "command"> {
  return {
    licence: codec.licence,
    workerd: codec.workerd,
    cli: codec.cli,
    csharp: false,
    weight: tsWeight(codec.packages),
    ...(codec.never ? { never: codec.never } : {}),
  };
}

function tsDecoderRows(): Candidate[] {
  return DECODERS.flatMap((decoder) =>
    ["sequential", "parallel"].map((mode): Candidate => ({
      label: `${decoder} ${mode}`,
      engine: "TS",
      kind: "decoder",
      command: tsCommand(decoder, mode, "none"),
      ...tsRow(CODECS[decoder]),
    })),
  );
}

/** The pngjs levels are pngjs; every other encoder is the library of the decoder of its name. */
function overlayCodec(overlay: OverlayName): Codec {
  return CODECS[isDecoder(overlay) ? overlay : "pngjs"];
}

function overlayRows(): Candidate[] {
  return OVERLAYS.filter((o) => o !== "none").map((overlay): Candidate => ({
    label: `overlay ${overlay}`,
    engine: "TS",
    kind: "overlay",
    command: tsCommand("pngjs", "sequential", overlay),
    ...tsRow(overlayCodec(overlay)),
  }));
}

/** Every row the table has, measurable or not. Pure: what is on disk only decides `missing`. */
export function candidates(): Candidate[] {
  return [
    ...csRows(),
    ...tsDecoderRows(),
    ...overlayRows(),
    {
      label: "pngjs sequential, bun build --compile",
      engine: "TS",
      kind: "startup",
      command: `${COMPILED} --decoder pngjs --decode sequential --overlay none`,
      licence: CODECS.pngjs.licence,
      workerd: false,
      cli: true,
      csharp: false,
      weight: [COMPILED],
    },
  ];
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
  warn("decoders: bun build --compile of the TS impl");
  mkdirSync(dirname(COMPILED), { recursive: true });
  await sh([
    "bun",
    "build",
    "--compile",
    TS_DIFF,
    join(ROOT, "bench/src/impl/ts-decode-worker.ts"),
    "--outfile",
    COMPILED,
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
