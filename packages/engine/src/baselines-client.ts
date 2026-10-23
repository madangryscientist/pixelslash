import {
  type BaselinePick,
  type DiffLocation,
  type PickedShot,
  isBaselinePick,
} from "./ci-diff.ts";
import { UploadError } from "./errors.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { type Client, isObj, send, sendPng } from "./upload-client.ts";

/**
 * The baselines half of the API, shared by `upload` (a build's `/baselines`) and `check` (the
 * read-only `POST /api/v1/baselines`): the shot key, the chunked fetch and the baseline image.
 */

/** The pinned capture image is Linux; the manifest carries no platform of its own. */
export const PLATFORM = "linux";

/** Keys per baselines request: the server takes up to 2000. */
const KEYS_PER_REQUEST = 500;

/** What the preview says a build would remove: a key the baseline build has and this one lacks. */
export type RemovedKey = { name: string; browser: string; viewport: string; theme: string };

export function snapshotKey(e: SnapshotEntry) {
  const { width, height } = e.variant.viewport;
  const { browser, theme } = e.variant;
  return { name: e.name, platform: PLATFORM, browser, viewport: `${width}x${height}`, theme };
}

const removedId = (k: RemovedKey) => [k.name, k.browser, k.viewport, k.theme].join(" / ");

function isRemovedKey(v: unknown): v is RemovedKey {
  return (
    isObj(v) &&
    ["name", "browser", "viewport", "theme"].every((k) => typeof Reflect.get(v, k) === "string")
  );
}

/** A key the baseline build has is removed only when no request asked about it: all of them name it. */
function intersect(chunks: RemovedKey[][]): RemovedKey[] {
  const [first = [], ...rest] = chunks;
  const rests = rest.map((c) => new Set(c.map(removedId)));
  return first.filter((k) => rests.every((ids) => ids.has(removedId(k))));
}

export type BaselinesReply = {
  diffLocation: DiffLocation;
  picks: BaselinePick[];
  /** Undefined when the server does not say (any before ob 1732): nothing is then claimed. */
  removed: RemovedKey[] | undefined;
};

type Chunk = { picks: BaselinePick[]; ci: boolean; removed: RemovedKey[] | undefined };

function readChunk(client: Client, reply: unknown): Chunk {
  const sent: unknown[] = isObj(reply) && Array.isArray(reply.baselines) ? reply.baselines : [];
  if (sent.length === 0 || !sent.every(isBaselinePick))
    throw new UploadError(
      `${client.verb ?? "upload"} failed: fetch baselines: the server's reply has no baselines`,
    );
  const named = isObj(reply) && Array.isArray(reply.removed) ? reply.removed : undefined;
  return {
    picks: sent,
    ci: isObj(reply) && reply.diff_location === "ci",
    removed: named?.filter(isRemovedKey),
  };
}

/**
 * The server's pick for every shot, in `entries` order. `body` is sent beside each request's keys.
 * An error says `client.verb` failed, so `check` and `upload` each fail in their own words.
 */
export async function fetchBaselines(
  client: Client,
  request: { path: string; body?: object },
  entries: SnapshotEntry[],
): Promise<BaselinesReply> {
  const chunks: Chunk[] = [];
  for (let i = 0; i < entries.length; i += KEYS_PER_REQUEST) {
    const keys = entries.slice(i, i + KEYS_PER_REQUEST).map(snapshotKey);
    const body = JSON.stringify({ ...request.body, keys });
    const reply = await send(client, {
      step: "fetch baselines",
      method: "POST",
      path: request.path,
      body,
    });
    chunks.push(readChunk(client, reply));
  }
  const named = chunks.flatMap((c) => (c.removed ? [c.removed] : []));
  return {
    diffLocation: chunks.some((c) => c.ci) ? "ci" : "server",
    picks: chunks.flatMap((c) => c.picks),
    removed: named.length === chunks.length ? intersect(named) : undefined,
  };
}

/** A baseline image, through the signed link the server gave, on the server the CLI was pointed at. */
export function baselinePng(client: Client, picked: PickedShot): Promise<Buffer> {
  const url = new URL(picked.image_url, client.base);
  return sendPng(client, {
    step: `fetch baseline ${picked.id}`,
    method: "GET",
    path: `${url.pathname}${url.search}`,
  });
}
