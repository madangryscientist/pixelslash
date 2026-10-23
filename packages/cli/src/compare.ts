import { resolve } from "node:path";
import { UsageError, changeLines, compareSnapshots, timingLine } from "@pixelslash/engine";
import type { Io } from "./run.ts";
import { readFlagPairs } from "./args.ts";

export const COMPARE_USAGE =
  "pixelslash compare MAIN_DIR BRANCH_DIR [--out DIR]\nBoth are `pixelslash capture` snapshot dirs. No design system, no server.";

/** `pixelslash compare MAIN_DIR BRANCH_DIR`: diff two snapshot dirs locally. Exit 0; 2 on a bad dir or manifest. */
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
  io.stdout.write(
    `pixelslash: ${r.changed.length} changed, ${r.unchanged.length} unchanged, ${r.added.length} new, ${r.removed.length} removed\n`,
  );
  for (const line of changeLines(r)) io.stdout.write(`${line}\n`);
  if (r.mismatched.length > 0)
    io.stdout.write(`fingerprint: ${r.mismatched.length} differ (diffed anyway)\n`);
  io.stdout.write(`report: file://${r.indexPath}\n`);
  return 0;
}
