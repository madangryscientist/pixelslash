import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "./db";
import { snapshots } from "./schema";

/** How many rows one batch writes: few enough that a batch stays a small request. */
export const WRITES_PER_BATCH = 20;

type Fields = Partial<typeof snapshots.$inferInsert>;

/**
 * A diff run's writes to its shots' rows, sent several at a time as one `batch`, not one statement
 * per shot. On Cloudflare a batch is one round trip; on a self-host, whose D1 is a SQLite file, it is
 * one transaction and so one sync to disk, where a statement each was one sync each.
 *
 * A row is written when its batch is: the run flushes when `full` and before it ends or reads the
 * rows back, whatever ends it. A run that dies with writes queued has not stored those shots, and the
 * next run measures them again, as it would a shot that died mid-diff. Work that must follow a row's
 * write (deleting an overlay the row no longer names) runs after its batch, never before it, and
 * reports its own failure rather than throwing, so one failure does not skip the rest.
 */
export class SnapshotWrites {
  private queued: BatchItem<"sqlite">[] = [];
  private after: (() => Promise<void>)[] = [];
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Queue a row's update; `then` runs once the batch holding it is written. */
  update(id: string, fields: Fields, then?: () => Promise<void>): void {
    this.queued.push(this.db.update(snapshots).set(fields).where(eq(snapshots.id, id)));
    if (then) this.after.push(then);
  }

  get full(): boolean {
    return this.queued.length >= WRITES_PER_BATCH;
  }

  /** Write what is queued as one batch, then run what waited on it. */
  async flush(): Promise<void> {
    const [first, ...rest] = this.queued;
    const after = this.after;
    this.queued = [];
    this.after = [];
    if (first) await this.db.batch([first, ...rest]);
    for (const then of after) await then();
  }
}
