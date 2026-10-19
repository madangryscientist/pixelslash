import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureError,
  FigmaError,
  UsageError,
  compare,
  compareRoutes,
  fetchFigmaRasters,
  loadRoutes,
  resolveToken,
  type CompareResult,
  type Deps,
} from "@pixelslash/engine";
import { USAGE, parseArgs, type Cli } from "./args.ts";

export type Io = { stdout: { write(s: string): void }; stderr: { write(s: string): void } };

function fileUrl(path: string): string {
  return `file://${path}`;
}

/** `--file`: pull the Figma components into a temp dir and judge against that. */
async function figmaDs(cli: Cli, file: string, deps: Deps): Promise<string> {
  const token = await resolveToken(cli.tokenPath, deps.env ?? process.env);
  const dest = await mkdtemp(join(tmpdir(), "pixelslash-ds-"));
  await fetchFigmaRasters({
    fileKey: file,
    token,
    dest,
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
  });
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

export async function run(argv: string[], io: Io = process, deps: Deps = {}): Promise<number> {
  try {
    const cli = parseArgs(argv);
    if (cli.routesFile) cli.routes = await loadRoutes(cli.routesFile);
    if (cli.file) cli.ds = await figmaDs(cli, cli.file, deps);
    const result = cli.routes ? await compareRoutes(cli, deps) : await compare(cli, deps);
    return report(cli, result, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof CaptureError || e instanceof FigmaError) {
      io.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
