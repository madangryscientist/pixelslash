/**
 * A per-request timer for the `Server-Timing` header on every `/api/v1` response. A part is one
 * named stretch of the request (`auth`, `blob`, `db`); the same part timed twice adds up, and
 * `total` runs from the timer's creation to the moment the header is written.
 *
 * It is a measurement only: it never changes a body or a status. On Workers the clock moves at I/O,
 * so a part that is pure CPU reads as 0 or as the I/O right after it.
 */

import type { BlobStore } from "#/storage/blobs";

/** The part of a timer a lower layer needs: time a step under a name. */
export type PartTimer = {
  time<T>(part: string, fn: () => Promise<T>): Promise<T>;
};

/** Time `fn` under `part` when there is a timer, else just run it. */
export function timeIf<T>(
  timer: PartTimer | undefined,
  part: string,
  fn: () => Promise<T>,
): Promise<T> {
  return timer ? timer.time(part, fn) : fn();
}

/** `blobs` with every write counted under `blob`; without a timer, `blobs` itself. */
export function timedBlobs(blobs: BlobStore, timer: PartTimer | undefined): BlobStore {
  if (!timer) return blobs;
  return {
    put: (key, body, contentType) => timer.time("blob", () => blobs.put(key, body, contentType)),
    get: (key) => blobs.get(key),
    delete: (key) => blobs.delete(key),
  };
}

export class ServerTimer implements PartTimer {
  private readonly parts = new Map<string, number>();
  private readonly began: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.began = now();
  }

  /** Add `ms` to `part`. */
  add(part: string, ms: number): void {
    this.parts.set(part, (this.parts.get(part) ?? 0) + Math.max(0, ms));
  }

  /** Run `fn`, counting its time under `part` whether it resolves or throws. */
  async time<T>(part: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await fn();
    } finally {
      this.add(part, this.now() - started);
    }
  }

  /** `name;dur=<ms>` entries, comma separated, `total` last. */
  header(): string {
    const entries = [...this.parts, ["total", this.now() - this.began] as const];
    return entries.map(([name, ms]) => `${name};dur=${Math.round(ms * 100) / 100}`).join(", ");
  }
}

/** `res` with its `Server-Timing` header set; the body and the status are not touched. */
export function withServerTiming(res: Response, timer: ServerTimer): Response {
  const value = timer.header();
  try {
    res.headers.set("server-timing", value);
    return res;
  } catch {
    // A Response with immutable headers (one from a fetch): copy it, body and all.
    const copy = new Response(res.body, res);
    copy.headers.set("server-timing", value);
    return copy;
  }
}
