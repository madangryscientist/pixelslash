import type { HeldShot } from "#/db/held-snapshots";
import { BadRequest, bad } from "./errors";
import { object, parseFlaky, parseSnapshotInput } from "./validate";
import { MAX_KNOWN, SHA256 } from "./validate-known";

/** What `POST /builds/:id/snapshots/batch` takes. */

/** Shots one batch request may register; the same cap as one `/known` call. */
export const MAX_BATCH = MAX_KNOWN;

/**
 * The body: `{ "snapshots": [meta, ...] }`, each `meta` what a PUT's `meta` part holds, with
 * `sha256` required. Every item is checked as the PUT checks its meta, and one that fails fails the
 * request, so nothing is written for a batch that is partly wrong.
 */
export function parseBatch(raw: unknown): HeldShot[] {
  const list = object(raw, "body").snapshots;
  if (!Array.isArray(list) || list.length > MAX_BATCH)
    bad("snapshots", `must be an array of at most ${MAX_BATCH} shots`);
  return list.map((item: unknown, i) => {
    const where = `snapshots[${i}]`;
    const meta = object(item, where);
    if (typeof meta.sha256 !== "string" || !SHA256.test(meta.sha256))
      bad(`${where}.sha256`, "must be 64 lowercase hex characters");
    // A flake record or CI results need the shot's own PUT; dropping them here would lose them.
    for (const field of ["flake", "ci"])
      if (meta[field] !== undefined)
        bad(`${where}.${field}`, "is not taken here; use the shot's PUT");
    try {
      return {
        input: { ...parseSnapshotInput(meta), flaky: parseFlaky(meta.flaky) },
        sha256: meta.sha256,
      };
    } catch (e) {
      // The shared checks name the field, not the item: say which one of the batch it was.
      if (e instanceof BadRequest) throw new BadRequest(`${where}: ${e.message}`);
      throw e;
    }
  });
}
