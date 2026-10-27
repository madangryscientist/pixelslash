import { dirname, join } from "node:path";
import type { RemovedKey } from "./baselines-client.ts";
import type { CompareRow } from "./compare-report.ts";
import { type SnapshotCompareResult, shotKeyLabel } from "./compare-snapshots.ts";
import { identity } from "./manifest.ts";
import type { Region } from "./regions.ts";
import type { MediaBox } from "./page-areas.ts";
import type { SnapshotEntry } from "./snapshot.ts";

/** `pixelslash check`'s rows (ob 1732): what the server would remove, and `--json`'s shot list. */

export type CheckShot = {
  name: string;
  shot: string;
  status: "changed" | "unchanged" | "new" | "removed";
  changedPixels: number;
  regions: Region[];
  mismatch: string[];
  flaky: { runs: number; differed: number } | undefined;
  /** The `<video>` / `<audio>` on the shot that no ignore area covers, in CSS px: add an exclusion zone for each. */
  media: MediaBox[];
  files: { branch?: string; main?: string; diff?: string; report?: string };
};

/** A removed key as a row; its scheme is named when the run's schemes vary, as `compare` does. */
function removedRow(k: RemovedKey, varied: boolean): CompareRow {
  return {
    name: k.name,
    shot: shotKeyLabel(k, varied),
    report: undefined,
    changedPixels: 0,
    mismatch: [],
    key: "",
    regions: [],
  };
}

/**
 * The removed keys as rows, those of the routes `--only` named; schemes named as `compare` does.
 * `undefined` is a server that does not say, which adds nothing.
 */
export function addRemoved(
  result: SnapshotCompareResult,
  removed: RemovedKey[] | undefined,
  entries: SnapshotEntry[],
  only: string[] | undefined,
): void {
  if (!removed) return;
  const names = only ? new Set(only) : undefined;
  const schemes = new Set([...entries.map((e) => e.variant.theme), ...removed.map((k) => k.theme)]);
  for (const k of removed)
    if (!names || names.has(k.name)) result.removed.push(removedRow(k, schemes.size > 1));
}

export function shotsOf(
  result: SnapshotCompareResult,
  entries: SnapshotEntry[],
  dirs: { branch: string; main: string; report: string },
  media: Record<string, MediaBox[]> = {},
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
        media: media[row.key] ?? [],
        files: {
          ...(e && { branch: join(dirs.branch, e.file) }),
          ...(e && measured && { main: join(dirs.main, e.file) }),
          ...(report && { diff: join(dirname(report), "diff.png"), report }),
        },
      };
    }),
  );
}
