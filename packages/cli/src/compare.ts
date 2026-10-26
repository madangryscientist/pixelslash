import { resolve } from "node:path";
import {
  UsageError,
  changeLines,
  compareSnapshots,
  type SnapshotCompareResult,
  newUploadProgress,
  notComparedLines,
  notComparedSummary,
  timingLine,
} from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { readFlagPairs } from "./args.ts";
import { ESCALATE, INTERNAL_EXIT, failedLines } from "./failure.ts";

export const COMPARE_USAGE =
  "pixelslash compare MAIN_DIR BRANCH_DIR [--out DIR]\nBoth are `pixelslash capture` snapshot dirs. No design system, no server.\nA shot the diff cannot measure is `not compared` in the report and the summary, and the exit is 7. " +
  ESCALATE;

/** The counts line, byte for byte as a script parses it; `, N not compared` only when some were. */
function countsLine(r: SnapshotCompareResult): string {
  const failed = r.failed.length > 0 ? `, ${r.failed.length} not compared` : "";
  return `pixelslash: ${r.changed.length} changed, ${r.unchanged.length} unchanged, ${r.added.length} new, ${r.removed.length} removed${failed}`;
}

/** The run went on and the report is written, but shots were not measured: loud, never exit 1. */
function failCompare(failed: SnapshotCompareResult["failed"], io: Io): number {
  const lines = failedLines(
    "compare",
    "compare",
    notComparedSummary({ failed }),
    newUploadProgress(),
  );
  io.stderr.write(`${lines.join("\n")}\n`);
  return INTERNAL_EXIT;
}

/** `pixelslash compare MAIN_DIR BRANCH_DIR`: diff two snapshot dirs locally. Exit 0; 2 on a bad dir or manifest; 7 when the diff threw on a shot, which is then `not compared`. */
export async function runCompare(argv: string[], io: Io): Promise<number> {
  const [mainDir, branchDir, ...rest] = argv;
  if (!mainDir || mainDir.startsWith("--") || !branchDir || branchDir.startsWith("--"))
    throw new UsageError("need a MAIN_DIR and a BRANCH_DIR");
  const { out = "pixelslash-compare" } = readFlagPairs(rest, ["out"]);
  const r = await compareSnapshots(
    { mainDir: resolve(mainDir), branchDir: resolve(branchDir), out: resolve(out) },
    { warn: (m) => io.stderr.write(`${m}\n`) },
  );
  io.stderr.write(`${timingLine(r.timings)}\n`);
  io.stdout.write(`${countsLine(r)}\n`);
  for (const line of changeLines(r)) io.stdout.write(`${line}\n`);
  for (const line of notComparedLines(r)) io.stdout.write(`${line}\n`);
  if (r.mismatched.length > 0)
    io.stdout.write(`fingerprint: ${r.mismatched.length} differ (diffed anyway)\n`);
  io.stdout.write(`report: file://${r.indexPath}\n`);
  return r.failed.length === 0 ? 0 : failCompare(r.failed, io);
}
