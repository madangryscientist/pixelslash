import { integer } from "drizzle-orm/sqlite-core";

/**
 * How long the server's steps on a build took (ob 1792), in whole milliseconds, beside the CLI's own
 * `builds.timings`. Columns, not JSON: the AI steps finish on a queue consumer, long after the run
 * that wrote the rest, and a column each is written without reading the others back. A step the run
 * did not do is null, never 0 (a project with no model has no `explain_ms`). Beside `schema.ts`,
 * which `drizzle.config.ts` reads with it; `schema.ts` is at its line cap.
 *
 * The latest run's numbers: a resumed or re-run diff writes them afresh and sets `rerun`. The total
 * is not stored: it is `finished_at - processing_started_at`.
 */
export const serverTimingColumns = {
  /** When the last server step ended: the verdict, or later the last explanation or the summary. */
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  /** Build created to the diff run claiming it; null on a re-run, whose build was created long before. */
  queueMs: integer("queue_ms"),
  /** The diff itself: every shot measured, and a branch build's against main. */
  diffMs: integer("diff_ms"),
  /** From the shots being queued to the last of them settling (ob 1875); null with no model or no change. */
  explainMs: integer("explain_ms"),
  /** The one model call that writes the build's summary (ob 1668). */
  summaryMs: integer("summary_ms"),
  /** The numbers are a later run's: the build was resumed after a stop, or a shot was re-diffed. */
  rerun: integer("rerun", { mode: "boolean" }).notNull().default(false),
};

/**
 * How long one shot's compare took on this server (PS-233), in whole milliseconds: both images read
 * and diffed against the baseline, and against the carried shot too when there was one. Written by
 * the run that measured the shot, so a resumed run rewrites only what it measured; null when no run
 * here measured it (a CI result, a new shot, a failed diff, or a row older than the column).
 */
export const snapshotTimingColumns = {
  diffMs: integer("diff_ms"),
};
