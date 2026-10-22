/**
 * The Worker's CPU limit is 30 s and the diff runs inline in the finalise request (decided
 * 2026-10-20: inline for beta). A kill by the runtime cannot be caught, so the build stops itself
 * first: this is the share of that limit the shots may use, which leaves the rest for the baseline
 * pick, the removed markers and the verdict. Wall time stands in for CPU time, so it only errs
 * early.
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

  async spend(work: () => Promise<void>): Promise<void> {
    const began = this.now();
    await work();
    this.ran++;
    this.slowest = Math.max(this.slowest, this.now() - began);
  }
}
