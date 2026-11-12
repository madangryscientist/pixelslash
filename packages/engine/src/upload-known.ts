import { UploadError } from "./errors.ts";
import { type SnapshotEntry } from "./snapshot.ts";
import { pngPath } from "./manifest.ts";
import { type Client, isObj, send } from "./upload-client.ts";
import { sha256Of } from "./upload-form.ts";

/**
 * Which of a directory's PNGs the server already holds (PS-424): each is hashed, the hashes go to
 * `POST /builds/:id/known` in calls of at most `MAX_KNOWN`, and the ones it names are sent by hash
 * with no PNG. Anything that goes wrong here sends every PNG, as an upload always did.
 */

/** The most hashes one `/known` call takes (the server refuses more). */
export const MAX_KNOWN = 1000;

/** The hashes of `entries`' PNGs, each once. */
async function hashesOf(dir: string, entries: SnapshotEntry[]): Promise<string[]> {
  const hashes = new Set<string>();
  for (const e of entries)
    hashes.add(sha256Of(new Uint8Array(await Bun.file(pngPath(dir, e)).arrayBuffer())));
  return [...hashes];
}

/** What one `/known` call names: strings only, and only what was asked. */
async function askKnown(client: Client, buildId: string, part: string[]): Promise<string[]> {
  const reply = await send(client, {
    step: "check known images",
    method: "POST",
    path: `/api/v1/builds/${buildId}/known`,
    body: JSON.stringify({ sha256: part }),
  });
  const named = isObj(reply) && Array.isArray(reply.known) ? reply.known : [];
  return part.filter((h) => named.includes(h));
}

/**
 * The hashes of `entries` the server holds. An empty set when it holds none, when it is older than
 * this endpoint (a 404, said nothing about), or when the call failed (said once): the upload then
 * sends every PNG.
 */
export async function knownImages(
  client: Client,
  buildId: string,
  dir: string,
  entries: SnapshotEntry[],
): Promise<Set<string>> {
  const asked = await hashesOf(dir, entries);
  const known = new Set<string>();
  try {
    for (let at = 0; at < asked.length; at += MAX_KNOWN)
      for (const h of await askKnown(client, buildId, asked.slice(at, at + MAX_KNOWN)))
        known.add(h);
  } catch (e) {
    if (!(e instanceof UploadError)) throw e;
    // An older server has no such endpoint: it takes every PNG, and that is no news.
    if (e.status !== 404) client.warn(`${e.message}; sending every image`);
    return new Set();
  }
  return known;
}
