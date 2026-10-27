/**
 * The Worker's CPU limit is 30 s and the diff runs inline in the finalise request (decided
 * 2026-10-20: inline for beta). A kill by the runtime cannot be caught, so the build stops itself
 * first: this is the share of that limit the shots may use, which leaves the rest for the baseline
 * pick, the removed markers and the verdict. Explaining the changes with the project's model is
 * not in it: that runs off the explain queue with its own time (ob 1875). Wall time stands in for
 * CPU time, so it only errs early.
 */
export const DIFF_BUDGET_MS = 25_000;

/**
 * One run's share of the Worker's limit (`DIFF_BUDGET_MS`). The first shot always goes, so every
 * run makes progress; after that a shot goes only if it fits when it costs as much as the slowest.
 */
export class Budget {
  private readonly now: () => number;
  private readonly started: number;
  private ran = 0;
  slowest = 0;

  constructor(now: () => number) {
    this.now = now;
    this.started = now();
  }

  used(): number {
    return this.now() - this.started;
  }

  fits(): boolean {
    return this.ran === 0 || this.used() + this.slowest <= DIFF_BUDGET_MS;
  }

  /** Run one shot's `work`, handing it the moment it began so it need not read the clock again. */
  async spend(work: (began: number) => Promise<void>): Promise<void> {
    const began = this.now();
    await work(began);
    // The diff is synchronous: yield so the isolate answers other requests between shots.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.ran++;
    this.slowest = Math.max(this.slowest, this.now() - began);
  }
}

/**
 * This run stopped before the Worker's limit with shots left. Not a failure to start over from:
 * what was measured is kept, and the next finalise measures only the rest (ob 1645). Its count
 * includes shots a changed baseline sends back, which a count of rows with no result would miss.
 */
export class DiffCeilingError extends Error {
  readonly unmeasured: number;
  constructor(measured: number, total: number, usedMs: number, slowestMs: number) {
    super(
      `diff ceiling: measured ${measured} of ${total} shots (${total - measured} left); this run ` +
        `used ${(usedMs / 1000).toFixed(1)} s (slowest shot ${(slowestMs / 1000).toFixed(1)} s) ` +
        `and the next could pass the Worker's 30 s CPU limit. Finalise again to measure the rest.`,
    );
    this.name = "DiffCeilingError";
    this.unmeasured = total - measured;
  }
}
