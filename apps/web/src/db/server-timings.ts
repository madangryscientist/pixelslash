import { eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { builds } from "./schema";

/**
 * Writes of a build's server timings (ob 1792): the diff run's, then the queue consumer's. Every
 * one is a plain column write, so the run and the consumer never read each other's numbers back.
 */

/** What one diff run records on its build when it ends, at the verdict or at an error. */
export type RunTimings = {
  finishedAt: Date;
  /** Null on a re-run, whose build was created long before the run. */
  queueMs: number | null;
  /** Null when the run ended before the diff began. */
  diffMs: number | null;
  rerun: boolean;
};

/** Whole milliseconds from `from` to `to`; a clock that stepped back, or a fake one, never gives a negative. */
export const msBetween = (from: number, to: number): number => Math.max(0, Math.round(to - from));

/**
 * The fields a run's end writes. The AI steps are cleared: this run's explanations and summary are
 * queued after it, and the numbers are the latest run's, not a mix with an earlier one.
 */
export const runFields = (run: RunTimings) => ({
  finishedAt: run.finishedAt,
  queueMs: run.queueMs,
  diffMs: run.diffMs,
  rerun: run.rerun,
  explainMs: null,
  summaryMs: null,
});

/**
 * What a claim writes over the run before it: a build with `finished_at` has ended (PS-193). A
 * claim moves a build back to `processing`, and a run killed after it (the Worker is OOM-killed
 * mid-diff) never writes its own end, so the earlier run's `finished_at` would sit on a build that
 * is not finished, before its new `processing_started_at`. The earlier run's numbers go with it:
 * they are not this run's, and the next end writes all of them again (`runFields`).
 */
export const unfinished = {
  finishedAt: null,
  queueMs: null,
  diffMs: null,
  explainMs: null,
  summaryMs: null,
} as const;

/**
 * `finished_at` for a late write by the explain queue: now, never earlier than the build's own,
 * and untouched while a run holds the build, whose end is that run's to write.
 */
export const finishedAfter = (at: number) =>
  sql`case when ${builds.status} = 'processing' then ${builds.finishedAt} else max(coalesce(${builds.finishedAt}, 0), ${at}) end`;

export async function recordRun(db: Db, buildId: string, run: RunTimings): Promise<void> {
  await db.update(builds).set(runFields(run)).where(eq(builds.id, buildId));
}

/**
 * A queued shot settled (explained, or given up): the explanation step has taken until now. Shots
 * settle at once, so the write keeps the largest of the numbers: the last to settle is the step's
 * end. `now` is the consumer's clock, the one `queuedAt` came from; `finished_at` is wall time.
 */
export async function recordExplained(
  db: Db,
  buildId: string,
  { queuedAt, now }: { queuedAt: number; now: number },
): Promise<void> {
  const finished = Date.now();
  await db
    .update(builds)
    .set({
      explainMs: sql`max(coalesce(${builds.explainMs}, 0), ${msBetween(queuedAt, now)})`,
      finishedAt: finishedAfter(finished),
    })
    .where(eq(builds.id, buildId));
}
