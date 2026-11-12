import { availableParallelism, loadavg } from "node:os";

/**
 * How long a run's steps took (ob 1791), in whole milliseconds. A step the run did not do is
 * absent, never 0: a run with no judge has no `judgeMs`. Timings stay on the machine; the only
 * place they go is the build's finalize body, with `--upload`, to the configured server.
 */

/** How long each settle condition waited (PS-195), in the order they run. */
export type SettleSteps = {
  fontsMs: number;
  imagesMs: number;
  networkIdleMs: number;
  framesMs: number;
};

/**
 * Where a capture's time went (PS-195): `navigateMs` is the `goto` until DOMContentLoaded,
 * `settleMs` the settle wait (split per condition in `settle`), `screenshotMs` the screenshot
 * call with Chromium's PNG encode. Parts of `captureMs`. A pair's two pages are shot at once, so its
 * parts add both pages' time and can exceed its `captureMs`.
 *
 * Three more parts, each present only when the shot did the step: `setupMs` is the browser context
 * and page the shot is taken in (with the clock pin), `storyMs` is the Storybook render wait,
 * which sits inside `settleMs` (the story and the generic settle share one wait), and `measureMs` is
 * what is read off the page once it is shot (ignore boxes, media, composition, metrics, a11y scan).
 */
export type CaptureSteps = {
  navigateMs: number;
  settleMs: number;
  screenshotMs: number;
  settle: SettleSteps;
  setupMs?: number;
  storyMs?: number;
  measureMs?: number;
};

/** One shot (or one route / pair): the steps it went through. */
export type ShotTiming = Partial<CaptureSteps> & {
  name: string;
  /** Load, settle and screenshot. */
  captureMs?: number;
  /** The pixel diff and its regions. */
  diffMs?: number;
  judgeMs?: number;
};

/**
 * The requests of one kind sent to the server: `open build`, `fetch baseline`, `upload`, `finalize`.
 * `ms` adds every request's own time (worker time); `wallMs` runs from the first request's start to
 * the last one's end, and with requests in flight together it is less than `ms`. `p50Ms`, `p90Ms`
 * and `maxMs` are the spread of one request's latency.
 */
type RequestBatch = {
  step: string;
  /**
   * The server's own split of these requests (its `Server-Timing` parts, summed over the kind, in
   * whole milliseconds): where the time went on the server. Absent when the server sent none.
   */
  server?: Record<string, number>;
  count: number;
  ms: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  wallMs: number;
};

type UploadTiming = { totalMs: number; batches: RequestBatch[] };

/** The machine the run was on: its cores, and the one-minute load average at the start and the end of the run. */
type HostTiming = { cores: number; loadStart: number; loadEnd: number };

/** How many things ran at once: capture's shots and the upload's PUTs. */
type WorkerCounts = { capture?: number; upload?: number };

export type Timings = Partial<CaptureSteps> & {
  totalMs: number;
  /** Launching the browser, once per run (PS-195); absent when the run launched none. */
  browserLaunchMs?: number;
  /** The wall clock of the capture, with the shots overlapping: `captureMs` below is the workers' time added up. */
  captureWallMs?: number;
  workers?: WorkerCounts;
  host?: HostTiming;
  /** The sums of the per-shot steps; each present only when some shot did the step. */
  captureMs?: number;
  diffMs?: number;
  judgeMs?: number;
  upload?: UploadTiming;
  /** Slowest first. */
  shots: ShotTiming[];
};

const STEPS = ["captureMs", "diffMs", "judgeMs"] as const;
/** Parts of `captureMs`: summed like the steps, never added to a shot's total. */
const PARTS = [
  "navigateMs",
  "settleMs",
  "screenshotMs",
  "setupMs",
  "storyMs",
  "measureMs",
] as const;
const SETTLE = ["fontsMs", "imagesMs", "networkIdleMs", "framesMs"] as const;

/** `a` and `b` added up, part by part: a pair's two captures as one shot's steps. */
export function addSteps(a: CaptureSteps, b: CaptureSteps): CaptureSteps {
  const settle = { ...b.settle };
  for (const k of SETTLE) settle[k] += a.settle[k];
  return {
    navigateMs: a.navigateMs + b.navigateMs,
    settleMs: a.settleMs + b.settleMs,
    screenshotMs: a.screenshotMs + b.screenshotMs,
    settle,
  };
}

/** The one-minute load average now, to two places; 0 where the platform has none. */
export function loadNow(): number {
  return Math.round((loadavg()[0] ?? 0) * 100) / 100;
}

/** What a run knows beyond its shots: how its capture overlapped, its worker counts, and the load when it began. */
type RunFacts = {
  captureWallMs?: number | undefined;
  workers?: WorkerCounts | undefined;
  /** `loadNow()` read when the run began; with it, the timings carry a `host`. */
  loadStart?: number | undefined;
};

/** The run facts of a capture: what `captureInto` measured, and the load read before it began. */
export function captureFacts(
  result: { captureWallMs?: number | undefined; captureWorkers?: number | undefined },
  loadStart?: number,
): RunFacts {
  return {
    captureWallMs: result.captureWallMs,
    workers: result.captureWorkers === undefined ? undefined : { capture: result.captureWorkers },
    loadStart,
  };
}

/** Whole milliseconds since `since` (a `performance.now()` reading). */
export function elapsed(since: number): number {
  return Math.max(0, Math.round(performance.now() - since));
}

/** Time `fn`, and give back its result with the milliseconds it took. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: elapsed(started) };
}

function shotTotal(s: ShotTiming): number {
  return STEPS.reduce((n, k) => n + (s[k] ?? 0), 0);
}

/** The run-wide facts that are present: the launch, the capture wall, the worker counts and the host. */
function runFields(browserLaunchMs: number | undefined, facts: RunFacts): Partial<Timings> {
  const { capture, upload } = facts.workers ?? {};
  const workers: WorkerCounts = {
    ...(capture !== undefined && { capture }),
    ...(upload !== undefined && { upload }),
  };
  return {
    ...(browserLaunchMs !== undefined && { browserLaunchMs }),
    ...(facts.captureWallMs !== undefined && { captureWallMs: facts.captureWallMs }),
    ...(Object.keys(workers).length > 0 && { workers }),
    ...(facts.loadStart !== undefined && {
      host: { cores: availableParallelism(), loadStart: facts.loadStart, loadEnd: loadNow() },
    }),
  };
}

/** The sums of the per-shot steps and parts, and of the settle split, over the shots that did them. */
function sumShots(shots: ShotTiming[]): Partial<Timings> {
  const sums: Partial<Timings> = {};
  for (const k of [...STEPS, ...PARTS]) {
    const has = shots.filter((s) => s[k] !== undefined);
    if (has.length > 0) sums[k] = has.reduce((n, s) => n + (s[k] ?? 0), 0);
  }
  const settled = shots.flatMap((s) => (s.settle ? [s.settle] : []));
  if (settled.length > 0) {
    const settle = { fontsMs: 0, imagesMs: 0, networkIdleMs: 0, framesMs: 0 };
    for (const s of settled) for (const k of SETTLE) settle[k] += s[k];
    sums.settle = settle;
  }
  return sums;
}

/** The timings of `shots` over a run that began at `started`; sums and the slowest-first order are made here. */
export function buildTimings(
  started: number,
  shots: ShotTiming[],
  browserLaunchMs?: number,
  facts: RunFacts = {},
): Timings {
  return {
    totalMs: elapsed(started),
    ...runFields(browserLaunchMs, facts),
    ...sumShots(shots),
    shots: shots.toSorted((a, b) => shotTotal(b) - shotTotal(a)),
  };
}

const KIND_PREFIXES = ["upload ", "fetch baseline"];

/** A request's step as the batch it counts in: `upload home/desktop.png` is an `upload`, `fetch baseline <id>` and `fetch baselines` are `fetch baseline`. */
function requestKind(step: string): string {
  const prefix = KIND_PREFIXES.find((p) => step.startsWith(p));
  return prefix ? prefix.trim() : step;
}

/** The `p`th percentile (nearest rank) of `sorted`, ascending and not empty. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

type Seen = {
  durations: number[];
  first: number;
  last: number;
  server: Map<string, number>;
};

/** Collects the requests of an upload by kind. */
export function requestLog() {
  const seen = new Map<string, Seen>();
  const started = performance.now();
  return {
    record(step: string, ms: number, server?: Record<string, number>): void {
      const kind = requestKind(step);
      const end = performance.now();
      const batch = seen.get(kind) ?? {
        durations: [],
        first: end - ms,
        last: end,
        server: new Map<string, number>(),
      };
      for (const [part, partMs] of Object.entries(server ?? {}))
        batch.server.set(part, (batch.server.get(part) ?? 0) + partMs);
      batch.durations.push(Math.round(ms));
      batch.first = Math.min(batch.first, end - ms);
      batch.last = Math.max(batch.last, end);
      seen.set(kind, batch);
    },
    finish(): UploadTiming {
      const batches = [...seen].map(([step, { durations, first, last, server }]) => {
        const sorted = durations.toSorted((a, b) => a - b);
        return {
          step,
          ...(server.size > 0 && {
            server: Object.fromEntries([...server].map(([part, ms]) => [part, Math.round(ms)])),
          }),
          count: sorted.length,
          ms: sorted.reduce((n, d) => n + d, 0),
          p50Ms: percentile(sorted, 0.5),
          p90Ms: percentile(sorted, 0.9),
          maxMs: sorted.at(-1) ?? 0,
          wallMs: Math.max(0, Math.round(last - first)),
        };
      });
      return { totalMs: elapsed(started), batches };
    },
  };
}

/** Several lists of per-shot timings, joined by shot name: one capture list and one diff list make the rows. */
export function mergeShots(...lists: ShotTiming[][]): ShotTiming[] {
  const by = new Map<string, ShotTiming>();
  for (const list of lists) for (const s of list) by.set(s.name, { ...by.get(s.name), ...s });
  return [...by.values()];
}

/** What the upload itself contributes at finalize: its per-shot steps, its worker count and the load it began at. */
export type UploadRun = { shots: ShotTiming[] } & Pick<RunFacts, "workers" | "loadStart">;

/**
 * What the upload sends the server at finalize: the CLI's timings so far (its capture, when it
 * captured) and the upload's own per-shot `run.shots` (diff, judge; a shot with neither is left out), with the upload's requests up to,
 * not including, the finalize itself.
 */
export function timingsToSend(
  base: Timings | undefined,
  started: number,
  upload: UploadTiming,
  run: UploadRun,
): Timings {
  const prior: Partial<Timings> = base ?? {};
  const did = run.shots.filter((s) => s.diffMs !== undefined || s.judgeMs !== undefined);
  const sums = buildTimings(started, mergeShots(prior.shots ?? [], did), prior.browserLaunchMs, {
    captureWallMs: prior.captureWallMs,
    workers: { ...prior.workers, ...run.workers },
    // The capture's start load when there was a capture, else the upload's own.
    loadStart: prior.host?.loadStart ?? run.loadStart,
  });
  return { ...sums, totalMs: (prior.totalMs ?? 0) + elapsed(started), upload };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The one stderr line: `timing: 12 shots, capture 8.4s, diff 1.2s, upload 2.0s, total 11.9s`.
 * A step the run did not do is left out.
 */
export function timingLine(t: Timings, count = t.shots.length): string {
  const parts = [`${count} ${count === 1 ? "shot" : "shots"}`];
  if (t.captureMs !== undefined) parts.push(`capture ${seconds(t.captureMs)}`);
  if (t.diffMs !== undefined) parts.push(`diff ${seconds(t.diffMs)}`);
  if (t.judgeMs !== undefined) parts.push(`judge ${seconds(t.judgeMs)}`);
  if (t.upload) parts.push(`upload ${seconds(t.upload.totalMs)}`);
  parts.push(`total ${seconds(t.totalMs)}`);
  return `timing: ${parts.join(", ")}`;
}
