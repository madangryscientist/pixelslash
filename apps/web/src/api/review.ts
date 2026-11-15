import { type Actor, actorBuild, actorSnapshot } from "#/db/actor";
import type { Db } from "#/db/db";
import { type Decided, decideAll, decideShot } from "#/db/review";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import { jsonBody } from "./json-body";
import { reply } from "./read";
import { BadRequest, Forbidden, object } from "./validate";

/**
 * Review over the API: accept or reject one shot, or accept a whole build, with the web app's
 * effect. The decision code is the app's (`decideShot`, `decideAll`), and the PR's commit status
 * is synced after it as the app does. Only a person decides, so a CI or org token gets 403 before
 * anything else is read; the decision is recorded under the token's user.
 */

type ReviewCtx = {
  db: Db;
  actor: Actor;
  request: Request;
  checkRuns?: Omit<CheckRunDeps, "db"> | undefined;
};

function userOf(actor: Actor): string {
  if (actor.kind !== "user") throw new Forbidden("a review decision needs a personal token");
  return actor.userId;
}

function stateOf(body: unknown): "accepted" | "rejected" {
  const state = object(body, "body").state;
  if (state !== "accepted" && state !== "rejected")
    throw new BadRequest('state must be "accepted" or "rejected"');
  return state;
}

/** The verdict and the builds it moved (the decided one first), once GitHub is told. */
async function settled(ctx: ReviewCtx, decided: Decided): Promise<Response> {
  if (ctx.checkRuns) await syncCheckRuns({ db: ctx.db, ...ctx.checkRuns }, decided.buildIds);
  return reply({ status: decided.verdict, build_ids: decided.buildIds });
}

/** `POST /api/v1/snapshots/:id/review`, `{ state }`: the snapshot's project comes from its row. */
export async function reviewShot(ctx: ReviewCtx, [snapshotId = ""]: string[]): Promise<Response> {
  const userId = userOf(ctx.actor);
  const state = stateOf(await jsonBody(ctx.request));
  const { projectId } = await actorSnapshot(ctx.db, ctx.actor, snapshotId);
  return settled(ctx, await decideShot(ctx.db, { projectId, snapshotId, state, userId }));
}

/** `POST /api/v1/builds/:id/accept-all`: every shot but a skipped flaky one. */
export async function acceptBuild(ctx: ReviewCtx, [buildId = ""]: string[]): Promise<Response> {
  const userId = userOf(ctx.actor);
  const { build } = await actorBuild(ctx.db, ctx.actor, buildId);
  return settled(ctx, await decideAll(ctx.db, { projectId: build.projectId, buildId, userId }));
}
