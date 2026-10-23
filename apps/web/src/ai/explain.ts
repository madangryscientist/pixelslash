import { Buffer } from "node:buffer";
import { type Box, regionCrops } from "@pixelslash/engine/region-crops";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Build } from "#/db/builds";
import { inChunks } from "#/db/chunks";
import type { Db } from "#/db/db";
import { projectModelFor } from "#/db/models";
import { type AiRegionNote, type AiReview, snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { DIFF_BUDGET_MS } from "#/diff/budget";
import { warn } from "#/lib/log";
import { MODEL_TIMEOUT_MS, type ModelFetch, explainRegion } from "./model";

/**
 * Explaining a build's changes (ob 1473): after the pixel diff, each `change` region of a changed
 * shot goes to the project's own model, as three crops of that region only, and the model's label
 * and sentence are stored on the shot. Nothing here can fail a build or hold it: a call that fails
 * is a region left unexplained, and a shot with none explained stores nothing ("skip: no judge").
 * A project with no model configured sends nothing to anyone. It runs on what the run's diff budget
 * (`DIFF_BUDGET_MS`) left, so explaining cannot push the request past the Worker's limit.
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

type Shot = typeof snapshots.$inferSelect;

async function readBlob(blobs: BlobStore, key: string): Promise<Buffer> {
  const stream = await blobs.get(key);
  if (!stream) throw new Error(`image ${key} is missing from storage`);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** The shots worth a call: changed, still undecided, measured with an overlay, not yet explained. */
async function shotsToExplain(db: Db, buildId: string, only?: string[]): Promise<Shot[]> {
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
  return rows.filter((row) => row.baselineKey && row.diffKey && row.diffResult);
}

/** One shot's notes: one call per `change` region, each with that region's crops only. */
async function explainShot(
  deps: ExplainDeps,
  endpoint: { baseUrl: string; model: string; apiKey: string },
  shot: Shot,
  timeoutMs: number,
): Promise<{ notes: AiRegionNote[]; whole: boolean; failure: string | null }> {
  const changes = (shot.diffResult?.regions ?? []).filter((r) => r.kind === "change");
  const asked: Box[] = changes.slice(0, MAX_REGIONS_PER_SHOT);
  if (asked.length === 0 || !shot.baselineKey || !shot.diffKey)
    return { notes: [], whole: false, failure: null };
  const [main, branch, diff] = await Promise.all([
    readBlob(deps.blobs, shot.baselineKey),
    readBlob(deps.blobs, shot.imageKey),
    readBlob(deps.blobs, shot.diffKey),
  ]);
  const crops = regionCrops({ main, branch, diff }, asked);
  const answers = await Promise.allSettled(
    asked.map(async (region, i) => {
      const crop = crops[i];
      if (!crop) throw new Error("region is outside the overlap");
      const answer = await explainRegion(endpoint, crop, deps.modelFetch, timeoutMs);
      const note: AiRegionNote = { x: region.x, y: region.y, w: region.w, h: region.h, ...answer };
      return note;
    }),
  );
  const notes = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  const failed = answers.find((a) => a.status === "rejected");
  return {
    notes,
    whole: notes.length === changes.length,
    failure: failed ? messageOf(failed.reason) : null,
  };
}

/** An error's message for the log. No message here carries the key (see `explainRegion`). */
function messageOf(e: unknown): string {
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
 * or a re-run measured it again, while the model was asked: then nothing is written.
 */
async function storeShot(
  deps: ExplainDeps,
  model: Model,
  shot: Shot,
  { now, timeoutMs }: { now: () => number; timeoutMs: number },
): Promise<{ passed: boolean; failure: string | null }> {
  const endpoint = { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey };
  const { notes, whole, failure } = await explainShot(deps, endpoint, shot, timeoutMs);
  if (notes.length === 0) return { passed: false, failure };
  const autoPassed =
    model.autoPassNoise &&
    whole &&
    !shot.diffResult?.sizeChanged &&
    notes.every((note) => note.label === "noise");
  const aiReview: AiReview = { model: model.model, at: now(), regions: notes, autoPassed };
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
  return { passed: autoPassed && written.length > 0, failure };
}

/**
 * Explain the build's changed, undecided shots with the project's model, and auto-pass a shot whose
 * every `change` region it labels noise when the project opted in. `startedAt` is when the run
 * began: explaining spends only what is left of that run's `DIFF_BUDGET_MS`. Returns how many it
 * auto-passed, so the caller can refresh the build's status. Never throws; a failure is logged once
 * per build, so a wrong key or URL can be found, and the shot is reviewed as plain pixels.
 */
export async function explainBuild(
  deps: ExplainDeps,
  build: Build,
  { startedAt, only }: { startedAt: number; only?: string[] },
): Promise<number> {
  const now = deps.now ?? Date.now;
  const until = startedAt + DIFF_BUDGET_MS;
  let passed = 0;
  let failure: string | null = null;
  try {
    const model = await projectModelFor(deps.db, build.projectId, deps.modelKeySecret);
    if (!model) return 0;
    let slowest = 0;
    for (const shot of await shotsToExplain(deps.db, build.id, only)) {
      if (now() + slowest >= until) break;
      const began = now();
      const timeoutMs = Math.min(MODEL_TIMEOUT_MS, until - began);
      // An image missing from storage or a PNG that does not decode: this shot is reviewed as plain pixels.
      const stored = await storeShot(deps, model, shot, { now, timeoutMs }).catch((e: unknown) => ({
        passed: false,
        failure: messageOf(e),
      }));
      if (stored.passed) passed++;
      failure ??= stored.failure;
      slowest = Math.max(slowest, now() - began);
    }
  } catch (e) {
    failure ??= `the model's settings could not be read: ${messageOf(e)}`;
  }
  if (failure)
    warn(
      `build ${build.id}: the project's model explained nothing for a shot or region: ${failure}`,
    );
  return passed;
}
