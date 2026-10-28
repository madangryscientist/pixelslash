import { type A11y, type A11yDiff, diffA11y } from "@pixelslash/engine/a11y-entry";
import { inArray } from "drizzle-orm";
import { inChunks } from "./chunks";
import type { Db } from "./db";
import { snapshots } from "./schema";

type Scanned = { id: string; a11y: A11y | null; baselineSnapshotId: string | null };

/**
 * Each scanned shot's scan against its baseline's (PS-238), by shot id; a shot that was not
 * scanned is absent, which the caller reads as `off`. A baseline without a scan, or no baseline,
 * leaves the shot `unbaselined`: nothing is called new.
 */
export async function a11yDiffsOf(db: Db, rows: Scanned[]): Promise<Map<string, A11yDiff>> {
  const scanned = rows.filter((r) => r.a11y);
  const ids = scanned.flatMap((r) => (r.baselineSnapshotId ? [r.baselineSnapshotId] : []));
  const found = await inChunks(ids, 0, (part) =>
    db
      .select({ id: snapshots.id, a11y: snapshots.a11y })
      .from(snapshots)
      .where(inArray(snapshots.id, part)),
  );
  const baselines = new Map(found.flatMap((f) => (f.a11y ? [[f.id, f.a11y] as const] : [])));
  return new Map(
    scanned.map((r) => [
      r.id,
      diffA11y(
        r.baselineSnapshotId ? baselines.get(r.baselineSnapshotId) : undefined,
        r.a11y ?? undefined,
      ),
    ]),
  );
}
