import { UploadError } from "./errors.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { identity } from "./manifest.ts";
import { type Client, send } from "./upload-client.ts";
import { heldBatch } from "./upload-batch.ts";
import { type ShotExtras, readShot, snapshotForm } from "./upload-form.ts";

/**
 * Send one shot. A PNG the server holds goes by hash; if it no longer finds it (409
 * `image_unknown`), the shot is sent again with its file.
 */
export async function putShot(
  client: Client,
  buildId: string,
  shot: {
    e: SnapshotEntry;
    png: Buffer;
    hash: string;
    extras: ShotExtras;
    known: ReadonlySet<string>;
  },
): Promise<void> {
  const put = (byHash: string | undefined) =>
    send(client, {
      step: `upload ${identity(shot.e)}`,
      method: "PUT",
      path: `/api/v1/builds/${buildId}/snapshots`,
      body: snapshotForm(shot.e, shot.png, { ...shot.extras, byHash }),
    });
  try {
    await put(shot.known.has(shot.hash) ? shot.hash : undefined);
  } catch (err) {
    if (!(err instanceof UploadError) || err.code !== "image_unknown") throw err;
    await put(undefined);
  }
}

/**
 * Where a measured shot goes. A held image with nothing else to send is queued and registered in a
 * batch (`flush` sends the last); any other shot goes by its own PUT.
 */
export function shotSender(
  client: Client,
  buildId: string,
  opts: { dir: string; known: ReadonlySet<string>; sent: () => void },
) {
  const { dir, known, sent } = opts;
  const batch = heldBatch(
    client,
    buildId,
    async (shot, byHash) => {
      const { png } = await readShot(dir, shot.e);
      const extras = { results: [], flake: undefined, note: shot.note, metrics: undefined };
      await putShot(client, buildId, {
        e: shot.e,
        png,
        hash: shot.hash,
        extras,
        known: byHash ? known : new Set(),
      });
    },
    sent,
  );
  return {
    async send(shot: { e: SnapshotEntry; png: Buffer; hash: string; extras: ShotExtras }) {
      const { e, hash, extras } = shot;
      if (known.has(hash) && batch.takes(extras)) return batch.add({ e, hash, note: extras.note });
      await putShot(client, buildId, { ...shot, known });
      sent();
    },
    flush: () => batch.flush(),
  };
}
