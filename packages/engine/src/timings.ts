/**
 * How long a run's steps took (ob 1791), in whole milliseconds. A step the run did not do is
 * absent, never 0: a run with no judge has no `judgeMs`. Timings stay on the machine; the only
 * place they go is the build's finalize body, with `--upload`, to the configured server.
 */

/** One shot (or one route / pair): the steps it went through. */
export type ShotTiming = {
  name: string;
  /** Load, settle and screenshot. */
  captureMs?: number;
  /** The pixel diff and its regions. */
  diffMs?: number;
  judgeMs?: number;
};

/** The requests of one kind sent to the server: `open build`, `fetch baseline`, `upload`, `finalize`. */
type RequestBatch = { step: string; count: number; ms: number };

type UploadTiming = { totalMs: number; batches: RequestBatch[] };

export type Timings = {
  totalMs: number;
  /** The sums of the per-shot steps; each present only when some shot did the step. */
  captureMs?: number;
  diffMs?: number;
  judgeMs?: number;
  upload?: UploadTiming;
  /** Slowest first. */
  shots: ShotTiming[];
};

const STEPS = ["captureMs", "diffMs", "judgeMs"] as const;

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

/** The timings of `shots` over a run that began at `started`; sums and the slowest-first order are made here. */
export function buildTimings(started: number, shots: ShotTiming[]): Timings {
  const timings: Timings = {
    totalMs: elapsed(started),
    shots: shots.toSorted((a, b) => shotTotal(b) - shotTotal(a)),
  };
  for (const k of STEPS) {
    const has = shots.filter((s) => s[k] !== undefined);
    if (has.length > 0) timings[k] = has.reduce((n, s) => n + (s[k] ?? 0), 0);
  }
  return timings;
}

const KIND_PREFIXES = ["upload ", "fetch baseline"];

/** A request's step as the batch it counts in: `upload home/desktop.png` is an `upload`, `fetch baseline <id>` and `fetch baselines` are `fetch baseline`. */
function requestKind(step: string): string {
  const prefix = KIND_PREFIXES.find((p) => step.startsWith(p));
  return prefix ? prefix.trim() : step;
}

/** Collects the requests of an upload by kind. */
export function requestLog() {
  const batches = new Map<string, RequestBatch>();
  const started = performance.now();
  return {
    record(step: string, ms: number): void {
      const kind = requestKind(step);
      const batch = batches.get(kind) ?? { step: kind, count: 0, ms: 0 };
      batch.count += 1;
      batch.ms += Math.round(ms);
      batches.set(kind, batch);
    },
    finish(): UploadTiming {
      return { totalMs: elapsed(started), batches: [...batches.values()] };
    },
  };
}

/** Several lists of per-shot timings, joined by shot name: one capture list and one diff list make the rows. */
export function mergeShots(...lists: ShotTiming[][]): ShotTiming[] {
  const by = new Map<string, ShotTiming>();
  for (const list of lists) for (const s of list) by.set(s.name, { ...by.get(s.name), ...s });
  return [...by.values()];
}

/**
 * What the upload sends the server at finalize: the CLI's timings so far (its capture, when it
 * captured) and the upload's own per-shot `shots` (diff, judge; a shot with neither is left out), with the upload's requests up to,
 * not including, the finalize itself.
 */
export function timingsToSend(
  base: Timings | undefined,
  started: number,
  upload: UploadTiming,
  shots: ShotTiming[],
): Timings {
  const did = shots.filter((s) => s.diffMs !== undefined || s.judgeMs !== undefined);
  const sums = buildTimings(started, mergeShots(base?.shots ?? [], did));
  return { ...sums, totalMs: (base?.totalMs ?? 0) + elapsed(started), upload };
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
