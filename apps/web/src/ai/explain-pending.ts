/**
 * Whether a shot or a build's summary is still waiting on the explain queue (ob 1875). Its own
 * module so the review view can read it without importing the queue's consumer.
 */

/** A shot or summary still queued after this is shown as stopped: no consumer will finish it. */
export const EXPLAIN_STALE_MS = 15 * 60_000;

export const STALE_FAILURE = "explaining stopped: no answer within 15 minutes";

/** Still being explained: queued, and not so long ago that its consumer must have died. */
export const explaining = (queuedAt: Date | null, now: number): boolean =>
  queuedAt !== null && now - queuedAt.getTime() < EXPLAIN_STALE_MS;
