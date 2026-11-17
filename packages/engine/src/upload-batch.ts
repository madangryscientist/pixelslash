import { UploadError } from "./errors.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { type Client, isObj, send } from "./upload-client.ts";
import { batchItem } from "./upload-form.ts";

/**
 * Shots the server already holds, registered many to a request: `POST
 * /builds/:id/snapshots/batch` takes each shot's meta and the hash of its PNG, authorizes once and
 * writes the rows together. A shot with anything else to send (a metrics file, a flake record, CI
 * results, an image the server lacks) still goes by its own PUT.
 */

/** The most shots one batch request takes (the server refuses more). */
export const MAX_BATCH = 1000;

/** A shot waiting to be registered: its entry, its PNG's hash and the judge's sentence. The PNG stays on disk. */
type HeldShot = { e: SnapshotEntry; hash: string; note: string | null };

/**
 * Register `shots` in one request. Returns the hashes the server no longer holds, which the caller
 * sends with their files, or `undefined` when the server has no such endpoint (an older one, a
 * 404): every shot then goes by its own PUT.
 */
async function registerHeld(
  client: Client,
  buildId: string,
  shots: HeldShot[],
): Promise<Set<string> | undefined> {
  try {
    const reply = await send(client, {
      step: "register held shots",
      method: "POST",
      path: `/api/v1/builds/${buildId}/snapshots/batch`,
      body: JSON.stringify({ snapshots: shots.map((s) => batchItem(s.e, s.hash, s.note)) }),
    });
    if (!isObj(reply) || !Array.isArray(reply.missing))
      throw new UploadError(
        `upload failed: register held shots: the server's reply names no missing hashes`,
      );
    return new Set(reply.missing.filter((h): h is string => typeof h === "string"));
  } catch (e) {
    if (e instanceof UploadError && e.status === 404) return undefined;
    throw e;
  }
}

type Extras = { results: unknown[]; flake?: { flaky: boolean } | undefined; metrics?: unknown };

/** How many of a batch's own PUTs run at once, as many as the upload's workers. */
const RESEND_AT_ONCE = 4;

/** Whether a shot sends nothing but its meta: no CI result, flake record or metrics file. */
export const sendsOnlyMeta = (extras: Extras): boolean =>
  extras.results.length === 0 && !extras.flake?.flaky && !extras.metrics;

/**
 * The queue of held, unchanged shots. `add` registers a full batch; `flush` the rest. A shot the
 * server no longer holds (named under `missing`), or every shot when the server has no batch
 * endpoint, goes through `put`, the shot's own PUT: `byHash` says whether it still names its image
 * by hash (the server lacks only the endpoint) or sends the file (the server lost the image).
 */
export function heldBatch(
  client: Client,
  buildId: string,
  put: (shot: HeldShot, byHash: boolean) => Promise<void>,
  sent: () => void,
) {
  let queue: HeldShot[] = [];
  let supported = true;
  async function register(shots: HeldShot[]): Promise<void> {
    const missing = await registerHeld(client, buildId, shots);
    if (!missing) supported = false;
    // The shots the server stored count at once, so a resend that fails leaves progress true.
    const resend = missing ? shots.filter((s) => missing.has(s.hash)) : shots;
    for (let i = 0; i < shots.length - resend.length; i++) sent();
    for (let i = 0; i < resend.length; i += RESEND_AT_ONCE)
      await Promise.all(
        resend.slice(i, i + RESEND_AT_ONCE).map(async (shot) => {
          await put(shot, missing === undefined);
          sent();
        }),
      );
  }
  return {
    /** Whether a shot with these extras may be registered here: it sends nothing but its meta. */
    takes: (extras: Extras) => supported && sendsOnlyMeta(extras),
    async add(shot: HeldShot): Promise<void> {
      queue.push(shot);
      if (queue.length >= MAX_BATCH) await register(queue.splice(0, MAX_BATCH));
    },
    async flush(): Promise<void> {
      while (queue.length > 0) await register(queue.splice(0, MAX_BATCH));
      queue = [];
    },
  };
}
