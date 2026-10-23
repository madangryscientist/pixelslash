import type { Build } from "#/db/builds";
import { type RunTimings, msBetween } from "#/db/server-timings";

/**
 * One diff run's clock (ob 1792): when it began, how long the diff took, and the record of both at
 * its end. Durations read the run's clock (`ProcessDeps.now`, the one the budget reads); the two
 * stored moments are wall time, so they sit beside `processing_started_at`, which is `startedAt`.
 */
export class RunTimer {
  readonly startedAt: Date;
  private diffMs: number | null = null;

  /** `rerun`: an earlier run had claimed this build (a resume after a stop) or a reviewer re-diffed a shot. */
  constructor(
    private readonly now: () => number,
    private readonly build: Build,
    readonly rerun: boolean,
  ) {
    this.startedAt = new Date();
  }

  /** Run the diff and time it, also when it throws: an errored build keeps what ran. */
  async diff<T>(measure: () => Promise<T>): Promise<T> {
    const from = this.now();
    try {
      return await measure();
    } finally {
      this.diffMs = msBetween(from, this.now());
    }
  }

  /** The run's numbers as of now; call it when the run ends. */
  ended(): RunTimings {
    return {
      finishedAt: new Date(),
      queueMs: this.rerun
        ? null
        : msBetween(this.build.createdAt.getTime(), this.startedAt.getTime()),
      diffMs: this.diffMs,
      rerun: this.rerun,
    };
  }
}
