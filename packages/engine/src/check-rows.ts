import { dirname, join } from "node:path";
import type { CompareRow } from "./compare-report.ts";
import type { SnapshotCompareResult } from "./compare-snapshots.ts";
import { identity } from "./manifest.ts";
import type { Region } from "./regions.ts";
import type { SnapshotEntry } from "./snapshot.ts";

/** `pixelslash check`'s rows (ob 1732): what the server would remove, and `--json`'s shot list. */

/** What the preview says a build would remove: a key the baseline build has and this one lacks. */
export type RemovedKey = { name: string; browser: string; viewport: string; theme: string };

export type CheckShot = {
  name: string;
  shot: string;
  status: "changed" | "unchanged" | "new" | "removed";
  changedPixels: number;
  regions: Region[];
  mismatch: string[];
  flaky: { runs: number; differed: number } | undefined;
  files: { branch?: string; main?: string; diff?: string; report?: string };
};

/** A removed key as a row; its scheme is named when the run's schemes vary, as `compare` does. */
function removedRow(k: RemovedKey, varied: boolean): CompareRow {
  const shot = `${k.browser} ${k.viewport}${varied ? ` prefers: ${k.theme}` : ""}`;
  return {
    name: k.name,
    shot,
    report: undefined,
    changedPixels: 0,
    mismatch: [],
    key: "",
    regions: [],
  };
}

/** The removed keys as rows, those of the routes `--only` named; schemes named as `compare` does. */
export function addRemoved(
  result: SnapshotCompareResult,
  removed: RemovedKey[],
  entries: SnapshotEntry[],
  only: string[] | undefined,
): void {
  const names = only ? new Set(only) : undefined;
  const schemes = new Set([...entries.map((e) => e.variant.theme), ...removed.map((k) => k.theme)]);
  for (const k of removed)
    if (!names || names.has(k.name)) result.removed.push(removedRow(k, schemes.size > 1));
}

export function shotsOf(
  result: SnapshotCompareResult,
  entries: SnapshotEntry[],
  dirs: { branch: string; main: string; report: string },
): CheckShot[] {
  const byKey = new Map(entries.map((e) => [identity(e), e]));
  const lists = [
    ["changed", result.changed],
    ["unchanged", result.unchanged],
    ["new", result.added],
    ["removed", result.removed],
  ] as const;
  return lists.flatMap(([status, rows]) =>
    rows.map((row) => {
      const e = byKey.get(row.key);
      const measured = status === "changed" || status === "unchanged";
      const report = row.report ? join(dirs.report, row.report) : undefined;
      return {
        name: row.name,
        shot: row.shot,
        status,
        changedPixels: row.changedPixels,
        regions: row.regions,
        mismatch: row.mismatch,
        flaky: row.flaky,
        files: {
          ...(e && { branch: join(dirs.branch, e.file) }),
          ...(e && measured && { main: join(dirs.main, e.file) }),
          ...(report && { diff: join(dirname(report), "diff.png"), report }),
        },
      };
    }),
  );
}
