import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureError,
  FigmaError,
  UploadError,
  UsageError,
  compare,
  compareRoutes,
  fetchFigmaRasters,
  loadRoutes,
  resolveToken,
  type CompareResult,
  type Deps,
  type SnapshotDeps,
  type UploadDeps,
} from "@pixelslash/engine";
import { USAGE, parseArgs, type Cli } from "./args.ts";
import { CAPTURE_USAGE, runCapture } from "./capture.ts";
import { COMPARE_USAGE, runCompare } from "./compare.ts";
import { UPLOAD_USAGE, runUpload } from "./upload.ts";

export type Io = { stdout: { write(s: string): void }; stderr: { write(s: string): void } };

function fileUrl(path: string): string {
  return `file://${path}`;
}

/** `--file`: pull the Figma components into a temp dir and judge against that. */
async function figmaDs(cli: Cli, file: string, deps: Deps): Promise<string> {
  const token = await resolveToken(cli.tokenPath, deps.env ?? process.env);
  const dest = await mkdtemp(join(tmpdir(), "pixelslash-ds-"));
  try {
    await fetchFigmaRasters({
      fileKey: file,
      token,
      dest,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    });
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/** Print the run summary and return the exit code: 1 only on NEW violations on Branch. */
function report(cli: Cli, result: CompareResult, io: Io): number {
  const link = `report: ${fileUrl(result.reportPath)}\n`;
  if (!cli.ds) {
    const px = result.changedPixels ?? result.manifest?.changedPixels ?? 0;
    io.stdout.write(`pixelslash: ${px} changed pixels\n${link}`);
    return 0;
  }
  if (result.skipped) {
    io.stdout.write(`skip: no judge\n${link}`);
    return 0;
  }
  const n = result.fresh.length;
  const names = result.fresh.map((v) => v.component).join(", ");
  const newBit = n === 0 ? "0 new" : `${n} new on branch (${names})`;
  io.stdout.write(`pixelslash: ${result.already.length} already on main, ${newBit}\n${link}`);
  return n === 0 ? 0 : 1;
}

export async function run(
  argv: string[],
  io: Io = process,
  deps: Deps & SnapshotDeps & UploadDeps = {},
): Promise<number> {
  if (argv[0] === "capture")
    return guarded(() => runCapture(argv.slice(1), io, deps), io, CAPTURE_USAGE);
  if (argv[0] === "compare") return guarded(() => runCompare(argv.slice(1), io), io, COMPARE_USAGE);
  if (argv[0] === "upload")
    return guarded(() => runUpload(argv.slice(1), io, deps), io, UPLOAD_USAGE);
  return guarded(
    async () => {
      const cli = parseArgs(argv);
      if (cli.routesFile) cli.routes = await loadRoutes(cli.routesFile);
      const figma = cli.file ? await figmaDs(cli, cli.file, deps) : undefined;
      if (figma) cli.ds = figma;
      try {
        const result = cli.routes ? await compareRoutes(cli, deps) : await compare(cli, deps);
        return report(cli, result, io);
      } finally {
        // `compare` has already copied the rasters into `--out/ds`, so the temp dir is spent.
        if (figma) await rm(figma, { recursive: true, force: true });
      }
    },
    io,
    USAGE,
  );
}

/** Map the known errors to exit codes: usage 2, capture, Figma or upload 1. Anything else is a bug and throws. */
async function guarded(work: () => Promise<number>, io: Io, usage: string): Promise<number> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n${usage}\n`);
      return 2;
    }
    if (e instanceof CaptureError || e instanceof FigmaError || e instanceof UploadError) {
      io.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
