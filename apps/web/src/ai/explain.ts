import { Buffer } from "node:buffer";
import { type Box, regionCrops } from "@hackcove/pixelslash-engine/region-crops";
import { release } from "@hackcove/pixelslash-engine/release";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { inChunks } from "#/db/chunks";
import type { Db } from "#/db/db";
import { projectModelFor } from "#/db/models";
import { type AiRegionNote, type AiReview, type AiUsage, snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { MODEL_TIMEOUT_MS, type ModelFetch, explainRegion } from "./model";
import { tally } from "./usage";

/**
 * Explaining a build's changes (ob 1473): after the pixel diff, each `change` region of a changed
 * shot goes to the project's own model, as three crops of that region only, and the model's label
 * and sentence are stored on the shot. Nothing here can fail a build or hold it: a call that fails
 * is a region left unexplained, and a shot with none explained stores nothing ("skip: no judge").
 * A project with no model configured sends nothing to anyone. It runs off the explain queue
 * (`explain-queue.ts`, ob 1875), after the finalise has replied, so each call has the whole
 * `MODEL_TIMEOUT_MS` rather than what the diff left of the request.
 */

export type ExplainDeps = {
  db: Db;
  blobs: BlobStore;
  now?: (() => number) | undefined;
  /** The model's transport; a test passes a stub. Never a real endpoint in tests. */
  modelFetch?: ModelFetch | undefined;
  /** `MODEL_KEY_SECRET`, which opens the project's stored model key (ob 1786). */
  modelKeySecret?: string | undefined;
};

/** Regions explained per shot; a shot with more is explained in part and never auto-passed. */
export const MAX_REGIONS_PER_SHOT = 8;

/**
 * Model calls a shot has open at once. A Worker invocation holds six connections and queues the
 * rest, while each call's timeout starts when it is made: a call waiting for a connection would
 * spend its `MODEL_TIMEOUT_MS` in that line. The rest start as one finishes.
 */
const MODEL_CONNECTIONS = 6;

/** `work` over `items`, at most `limit` at a time, settled in their order. */
async function settleLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T, i: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  // One iterator for every lane: each takes the next item when its last call settles.
  const queue = items.entries();
  const lane = async () => {
    for (const [i, item] of queue)
      results[i] = await work(item, i).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export type Shot = typeof snapshots.$inferSelect;

async function readBlob(blobs: BlobStore, key: string): Promise<Buffer> {
  const stream = await blobs.get(key);
  if (!stream) throw new Error(`image ${key} is missing from storage`);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** The shots worth a call: changed, still undecided, measured with an overlay and a `change` region, not yet explained. */
export async function shotsToExplain(db: Db, buildId: string, only?: string[]): Promise<Shot[]> {
  const worth = and(
    eq(snapshots.buildId, buildId),
    eq(snapshots.diffStatus, "changed"),
    eq(snapshots.reviewState, "pending"),
    isNull(snapshots.aiReview),
  );
  // A re-run may name every shot of a big build: the ids go in parts beside the three bound above.
  const rows = only
    ? await inChunks(only, 3, (part) =>
        db
          .select()
          .from(snapshots)
          .where(and(worth, inArray(snapshots.id, part))),
      )
    : await db.select().from(snapshots).where(worth);
  // A shot changed only in size has no `change` region: there is nothing to ask about it.
  return rows.filter(
    (row) =>
      row.baselineKey && row.diffKey && row.diffResult?.regions.some((r) => r.kind === "change"),
  );
}

/** One shot's notes: one call per `change` region, each with that region's crops only. */
async function explainShot(
  deps: ExplainDeps,
  endpoint: { baseUrl: string; model: string; apiKey: string },
  shot: Shot,
  buildId: string,
): Promise<{ notes: AiRegionNote[]; usage: AiUsage; whole: boolean; failure: string | null }> {
  const changes = (shot.diffResult?.regions ?? []).filter((r) => r.kind === "change");
  const asked: Box[] = changes.slice(0, MAX_REGIONS_PER_SHOT);
  if (asked.length === 0 || !shot.baselineKey || !shot.diffKey)
    return { notes: [], usage: tally([]), whole: false, failure: null };
  const [main, branch, diff] = await Promise.all([
    readBlob(deps.blobs, shot.baselineKey),
    readBlob(deps.blobs, shot.imageKey),
    readBlob(deps.blobs, shot.diffKey),
  ]);
  // The three shots as stored, read whole and dead once cut: freed now, not left to a collector a
  // Worker cannot call (PS-206, as the diff's uploads are in PS-200).
  let crops: ReturnType<typeof regionCrops>;
  try {
    crops = regionCrops({ main, branch, diff }, asked);
  } finally {
    release(main, branch, diff);
  }
  const answers = await settleLimited(asked, MODEL_CONNECTIONS, async (region, i) => {
    const crop = crops[i];
    if (!crop) throw new Error("region is outside the overlap");
    const { usage, ...answer } = await explainRegion(endpoint, crop, {
      buildId,
      fetcher: deps.modelFetch,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    const note: AiRegionNote = { x: region.x, y: region.y, w: region.w, h: region.h, ...answer };
    return { note, usage };
  });
  const fulfilled = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  const notes = fulfilled.map((a) => a.note);
  const failed = answers.find((a) => a.status === "rejected");
  return {
    notes,
    // A failed call's tokens are not counted: only the answers stored.
    usage: tally(fulfilled.map((a) => a.usage)),
    whole: notes.length === changes.length,
    failure: failed ? messageOf(failed.reason) : null,
  };
}

/** An error's message for the log. No message here carries the key (see `explainRegion`). */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The shot still has the result the model was asked about: a re-run since then is not overwritten. */
function sameResult(shot: Shot) {
  return shot.diffResult ? eq(snapshots.diffResult, shot.diffResult) : isNull(snapshots.diffResult);
}

type Model = NonNullable<Awaited<ReturnType<typeof projectModelFor>>>;

/**
 * Explain one shot and store its notes, auto-passing it when the project opted in and the model
 * called every `change` region noise. A shot whose size changed is never auto-passed: its regions
 * cover only the overlap, so part of it was never measured. A reviewer may have decided the shot,
 * or a re-run measured it again, while the model was asked: then nothing is written. `stored` is
 * whether the model explained a region, written or not; `failure` is the first call that failed.
 */
export async function storeShot(
  deps: ExplainDeps,
  model: Model,
  shot: Shot,
  { buildId, now }: { buildId: string; now: () => number },
): Promise<{ stored: boolean; passed: boolean; failure: string | null }> {
  const endpoint = { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey };
  const { notes, usage, whole, failure } = await explainShot(deps, endpoint, shot, buildId);
  if (notes.length === 0) return { stored: false, passed: false, failure };
  const autoPassed =
    model.autoPassNoise &&
    whole &&
    !shot.diffResult?.sizeChanged &&
    notes.every((note) => note.label === "noise");
  const aiReview: AiReview = { model: model.model, at: now(), regions: notes, autoPassed, usage };
  const decided = autoPassed
    ? { reviewState: "accepted" as const, reviewedBy: null, reviewedAt: new Date(now()) }
    : {};
  const written = await deps.db
    .update(snapshots)
    .set({ aiReview, ...decided })
    .where(
      and(
        eq(snapshots.id, shot.id),
        eq(snapshots.reviewState, "pending"),
        isNull(snapshots.aiReview),
        sameResult(shot),
      ),
    )
    .returning({ id: snapshots.id });
  return { stored: true, passed: autoPassed && written.length > 0, failure };
}
