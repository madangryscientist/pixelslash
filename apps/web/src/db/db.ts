import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * The repository layer's seam. Every query in `src/db` takes this, never D1 itself: D1 in
 * production, in-memory SQLite in tests, and any async Drizzle SQLite driver for a self-host.
 */
export type Db = BaseSQLiteDatabase<"async", unknown>;

/** Thrown when a row does not exist or the viewer may not see it; the two are one 404. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
