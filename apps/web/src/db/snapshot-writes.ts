import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { snapshots } from "./schema";

/** How many rows one batch writes: few enough that a batch stays a small request. */
export const WRITES_PER_BATCH = 20;

type Fields = Partial<typeof snapshots.$inferInsert>;
type Row = typeof snapshots.$inferSelect;

/** Whether a field's new value is what the row holds: a date by its time, a JSON value by its text. */
function same(held: unknown, next: unknown): boolean {
  if (held === next || (held == null && next == null)) return true;
  if (held instanceof Date && next instanceof Date) return held.getTime() === next.getTime();
  if (typeof held === "object" && typeof next === "object")
    return JSON.stringify(held) === JSON.stringify(next);
  return false;
}

/** The fields whose value differs from what `row` holds. */
export function changedFields(row: Row, fields: Fields): Fields {
  const out: Fields = { ...fields };
  for (const [key, value] of Object.entries(out)) {
    const held: unknown = Reflect.get(row, key);
    if (value === undefined || same(held, value)) Reflect.deleteProperty(out, key);
  }
  return out;
}

/**
 * A diff run's writes to its shots' rows, sent several at a time as one `batch`, not one statement
 * per shot. On Cloudflare a batch is one round trip; on a self-host, whose D1 is a SQLite file, it is
 * one transaction and so one sync to disk, where a statement each was one sync each.
 *
 * D1 bills rows written, an index entry counting as a row, so a write sets only the fields whose
 * value differs from what the row holds: a shot whose result is what it was costs no statement,
 * and an indexed column left as it was costs no index write. Two writes to one row in the same
 * batch are one statement. A `hold` (the resolved options, written before the shot is measured)
 * waits for the shot's own result and goes in its statement; one no result follows is written by
 * `settle`, at the end of the run.
 *
 * A row is written when its batch is: the run flushes when `full`, and settles before it ends or
 * reads the rows back, whatever ends it. A run that dies with writes queued has not stored those
 * shots, and the next run measures them again, as it would a shot that died mid-diff. Work that
 * must follow a row's write (deleting an overlay the row no longer names) runs after its batch,
 * never before it, and reports its own failure rather than throwing, so one failure does not skip
 * the rest.
 */
export class SnapshotWrites {
  private queued = new Map<string, Fields>();
  private held = new Map<string, Fields>();
  private after: (() => Promise<void>)[] = [];
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Queue the fields of `row` that change; `then` runs once the batch holding it is written. */
  update(row: Row, fields: Fields, then?: () => Promise<void>): void {
    const changed = changedFields(row, fields);
    const held = this.held.get(row.id);
    this.held.delete(row.id);
    const merged = { ...held, ...this.queued.get(row.id), ...changed };
    if (Object.keys(merged).length > 0) this.queued.set(row.id, merged);
    if (then) this.after.push(then);
  }

  /** Keep the fields of `row` that change for its next `update`, or for `settle`. */
  hold(row: Row, fields: Fields): void {
    const changed = changedFields(row, fields);
    if (Object.keys(changed).length > 0)
      this.held.set(row.id, { ...this.held.get(row.id), ...changed });
  }

  get full(): boolean {
    return this.queued.size >= WRITES_PER_BATCH;
  }

  /** Write what is queued, in batches, then run what waited on it. */
  async flush(): Promise<void> {
    const queued = [...this.queued];
    const after = this.after;
    this.queued = new Map();
    this.after = [];
    for (let i = 0; i < queued.length; i += WRITES_PER_BATCH) {
      const [first, ...rest] = queued
        .slice(i, i + WRITES_PER_BATCH)
        .map(([id, fields]) => this.db.update(snapshots).set(fields).where(eq(snapshots.id, id)));
      if (first) await this.db.batch([first, ...rest]);
    }
    for (const then of after) await then();
  }

  /** Write everything, what is held included: the end of a run. */
  async settle(): Promise<void> {
    for (const [id, fields] of this.held)
      this.queued.set(id, { ...fields, ...this.queued.get(id) });
    this.held = new Map();
    await this.flush();
  }
}
