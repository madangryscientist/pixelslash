import { sql } from "drizzle-orm";
import { integer } from "drizzle-orm/sqlite-core";

/**
 * The `created_at` column every table carries. Beside `schema.ts`, which is at its line cap.
 *
 * Its SQL default, `unixepoch() * 1000`, has one-second resolution, and Drizzle prefers it to a
 * `$defaultFn`; changing it means rebuilding every table. So a build, whose order picks the newest
 * build and the baseline, writes `arrival()` itself (`createBuild`). Nothing orders the other
 * tables' rows by `created_at` alone, so they keep the default.
 */
export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

let last = 0;

/**
 * Now, to the millisecond, and always later than the last call in this process: two builds of one
 * project sent in the same second (parallel CI jobs on main), or in one millisecond, or while a
 * Worker's clock stands still between I/O, order by arrival rather than by their random ids. Two
 * isolates can still meet in one millisecond; then the id breaks the tie. Called once per build, so
 * it runs at most a millisecond a build ahead of the wall clock.
 */
export function arrival(): Date {
  last = Math.max(Date.now(), last + 1);
  return new Date(last);
}
