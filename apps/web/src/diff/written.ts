import type { SnapshotWrites } from "#/db/snapshot-writes";
import { reportError } from "#/server/sentry";

/**
 * Run `work`, then write what it queued, however it ends: a run stopped by the ceiling or by a
 * failed shot keeps what it measured, so the next run resumes from it. A write that fails after
 * `work` threw is reported, and the error `work` threw is the one the run ends on.
 */
export async function written(writes: SnapshotWrites, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    await writes.flush().catch((f: unknown) => reportError(f, { area: "diff", step: "write" }));
    throw e;
  }
  await writes.flush();
}
