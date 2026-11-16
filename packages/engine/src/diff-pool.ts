/**
 * The local comparisons, on at most `PIXELSLASH_DIFF_CORES` cores (`diff-cores.ts`). Every Bun call
 * site that diffs two PNGs (`compare`, `check`, `dev`, the upload's measure, the flake re-checks)
 * goes through `pooledDiff` or `pooledMeasure`, which run in the pool of the enclosing
 * `withDiffPool` scope, or in a pool of their own when there is none. With one core the diff runs
 * in-process, as it always did; with more, each comparison runs in a Bun `Worker` (`diff-worker.ts`),
 * at most one per worker, so no more than N are ever in flight. Workers start lazily and are
 * terminated when the scope ends, an error included.
 *
 * Bun only: `apps/web` imports `diff.ts` and `ci-diff.ts` for workerd, which has no threads, and
 * neither of those reaches this module. The server's own diff is not pooled.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  diffPngs,
  measurePngs,
  type DiffIgnore,
  type DiffOptions,
  type PixelDiff,
} from "./diff.ts";
import { diffCores } from "./diff-cores.ts";

/** What the pool sends a worker: the two PNGs as their own `ArrayBuffer`s, transferred. */
export type DiffRequest = {
  id: number;
  kind: "diff" | "measure";
  main: ArrayBuffer;
  branch: ArrayBuffer;
  options: DiffOptions;
  ignore: DiffIgnore;
};

/** What a worker answers: the diff with its overlay as plain bytes, or the message it threw. */
export type DiffReply =
  | { id: number; ok: true; result: Omit<PixelDiff, "overlay"> & { overlay: Uint8Array | null } }
  | { id: number; ok: false; message: string };

/** The part of a Bun `Worker` the pool uses; a test passes its own. */
export type WorkerLike = {
  postMessage(message: DiffRequest, transfer: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<DiffReply>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
};

type Job = Omit<DiffRequest, "id" | "main" | "branch"> & { main: Buffer; branch: Buffer };

export type DiffPool = {
  /** How many comparisons may be in flight at once. */
  readonly cores: number;
  run(job: Job): Promise<PixelDiff>;
  /** Terminate every worker; a job still queued or running is rejected. */
  close(): void;
};

/**
 * The worker entry beside this module: `diff-worker.js` in the CLI's `dist/` (a second entrypoint of
 * `scripts/build-cli.ts`), `diff-worker.ts` from source.
 */
function workerUrl(): URL {
  const built = new URL("./diff-worker.js", import.meta.url);
  return existsSync(fileURLToPath(built)) ? built : new URL("./diff-worker.ts", import.meta.url);
}

function bunWorker(): WorkerLike {
  return new Worker(workerUrl());
}

/** The whole of a buffer, copied into an `ArrayBuffer` of its own: the caller keeps its bytes. */
function own(bytes: Buffer): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function inProcess(): DiffPool {
  return {
    cores: 1,
    run: (job) =>
      new Promise((resolve) => {
        const run = job.kind === "measure" ? measurePngs : diffPngs;
        resolve(run(job.main, job.branch, job.options, job.ignore));
      }),
    close: () => {},
  };
}

type Pending = { resolve: (d: PixelDiff) => void; reject: (e: Error) => void };

function workerPool(cores: number, spawn: () => WorkerLike): DiffPool {
  const all = new Set<WorkerLike>();
  const idle: WorkerLike[] = [];
  const running = new Map<WorkerLike, Pending>();
  const queue: (Job & Pending)[] = [];
  let next = 0;
  let closed = false;

  const settle = (w: WorkerLike, reply: DiffReply) => {
    const job = running.get(w);
    running.delete(w);
    idle.push(w);
    if (job && reply.ok) {
      const { overlay, ...rest } = reply.result;
      const bytes = overlay && Buffer.from(overlay.buffer, overlay.byteOffset, overlay.byteLength);
      job.resolve({ ...rest, overlay: bytes });
    } else if (job && !reply.ok) job.reject(new Error(reply.message));
    pump();
  };

  // A worker that dies takes only its own job with it; the next job starts a fresh one.
  const crash = (w: WorkerLike, event: ErrorEvent) => {
    const job = running.get(w);
    running.delete(w);
    all.delete(w);
    w.terminate();
    job?.reject(new Error(event.message || "diff worker failed"));
    pump();
  };

  const start = (): WorkerLike => {
    const w = spawn();
    w.addEventListener("message", (event) => settle(w, event.data));
    w.addEventListener("error", (event) => crash(w, event));
    all.add(w);
    return w;
  };

  const pump = () => {
    while (queue.length > 0) {
      if (closed) return;
      const w = idle.pop() ?? (all.size < cores ? start() : undefined);
      if (!w) return;
      const item = queue.shift();
      if (!item) return;
      const { resolve, reject, ...job } = item;
      running.set(w, { resolve, reject });
      const main = own(job.main);
      const branch = own(job.branch);
      w.postMessage({ ...job, id: next++, main, branch }, [main, branch]);
    }
  };

  return {
    cores,
    run(job) {
      if (closed) return Promise.reject(new Error("diff pool closed"));
      return new Promise((resolve, reject) => {
        queue.push({ ...job, resolve, reject });
        pump();
      });
    },
    close() {
      closed = true;
      for (const w of all) w.terminate();
      const left = [...running.values(), ...queue.splice(0)];
      all.clear();
      idle.length = 0;
      running.clear();
      for (const job of left) job.reject(new Error("diff pool closed"));
    },
  };
}

/** A pool of `cores`: in-process for 1, else up to `cores` workers made by `spawn` (Bun `Worker`s). */
export function openDiffPool(cores: number, spawn: () => WorkerLike = bunWorker): DiffPool {
  return cores <= 1 ? inProcess() : workerPool(cores, spawn);
}

const scope = new AsyncLocalStorage<DiffPool>();

export type PoolOptions = {
  /** The cores to use; `diffCores()` (the env) when left out. */
  cores?: number;
  /** How a worker is made; a Bun `Worker` on `diff-worker` when left out. */
  spawn?: () => WorkerLike;
};

/**
 * Run `fn` with one diff pool for every `pooledDiff` and `pooledMeasure` inside it, and terminate
 * its workers when `fn` settles, a throw included. Inside another scope it reuses that one, unless
 * `opts` names a pool of its own.
 */
export async function withDiffPool<T>(fn: () => Promise<T>, opts: PoolOptions = {}): Promise<T> {
  if (scope.getStore() && opts.cores === undefined && !opts.spawn) return fn();
  const pool = openDiffPool(opts.cores ?? diffCores(), opts.spawn);
  try {
    return await scope.run(pool, fn);
  } finally {
    pool.close();
  }
}

/** The enclosing pool's cores (`diffCores()` outside one): how many shots a caller keeps going at once. */
export function poolCores(): number {
  return scope.getStore()?.cores ?? diffCores();
}

function through(job: Job): Promise<PixelDiff> {
  const pool = scope.getStore();
  if (pool) return pool.run(job);
  return withDiffPool(() => through(job));
}

/** `diffPngs` in the run's diff pool. */
export function pooledDiff(
  main: Buffer,
  branch: Buffer,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
): Promise<PixelDiff> {
  return through({ kind: "diff", main, branch, options, ignore });
}

/** `measurePngs` in the run's diff pool: always measured, so the overlay is set. */
export async function pooledMeasure(
  main: Buffer,
  branch: Buffer,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
): Promise<PixelDiff & { overlay: Buffer }> {
  const diff = await through({ kind: "measure", main, branch, options, ignore });
  if (!diff.overlay) throw new Error("measure returned no overlay");
  return { ...diff, overlay: diff.overlay };
}

/**
 * `fn` over `items`, at most `limit` at a time, the results in `items`' order. A failure stops new
 * items from starting and is thrown once the running ones have finished, so no diff is left in
 * flight when the pool closes.
 */
export async function mapInOrder<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  const queue = items.entries();
  let failure: { error: unknown } | undefined;
  // Every lane pulls from the one iterator, so each item is taken once.
  const lane = async () => {
    for (const [i, item] of queue) {
      try {
        results[i] = await fn(item, i);
      } catch (error) {
        failure ??= { error };
      }
      if (failure) return;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure) throw failure.error;
  return results;
}
