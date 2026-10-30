import { CaptureError, type CaptureSession } from "@pixelslash/engine";

/**
 * How a long local run reports to its caller (ob 1735): a progress line per shot, and a signal
 * that stops it before the next one. A shot already in the browser finishes, bounded by its
 * timeout. The CLI passes neither.
 */
export type Watch = {
  signal?: AbortSignal | undefined;
  progress?:
    | ((p: { done: number; total: number | undefined; message: string }) => void)
    | undefined;
};

/** `session`, its every shot counted and the signal checked before each. */
export function watched(session: CaptureSession, watch: Watch, total?: number): CaptureSession {
  let done = 0;
  return {
    ...session,
    shoot: async (route, variant) => {
      if (watch.signal?.aborted) throw new CaptureError("cancelled");
      const shot = await session.shoot(route, variant);
      done++;
      // A re-capture of a changed shot goes past the first count; past it, no total is claimed.
      const known = total !== undefined && done <= total ? total : undefined;
      watch.progress?.({ done, total: known, message: `shot ${route.name} (${variant.name})` });
      return shot;
    },
  };
}
