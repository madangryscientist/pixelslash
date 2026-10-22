import { type Actor, actorBuild, actorProject } from "#/db/actor";
import {
  type BaselineSnapshot,
  type PickFor,
  type SnapshotKey,
  selectBaselines,
  snapshotKeyOf,
} from "#/db/baselines";
import type { Db } from "#/db/db";
import type { DiffLocation } from "#/db/schema";
import { API_VERSION, imageUrl } from "./read";
import { BadRequest, object, parseNewBuild, parseSnapshotKey } from "./validate";

/**
 * The baselines a build's shots are measured against (ob 1727), for a CLI that diffs in CI. The
 * pick is the server's own (`db/baselines.ts`), the one finalise runs; the CLI is told it and
 * never picks for itself. A shot is diffed under its own options as uploaded, so only the
 * baseline's side is here: its image, the fingerprint it was rendered under and its ignore areas.
 */

export type BaselinesCtx = {
  db: Db;
  actor: Actor;
  origin: string;
  imageSecret: () => string;
};

/** A build holds at most this many shots worth asking about in one request. */
const MAX_KEYS = 2000;

function keysOf(body: unknown): SnapshotKey[] {
  const keys = object(body, "body").keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS)
    throw new BadRequest(`keys must be an array of at most ${MAX_KEYS} snapshot keys`);
  return keys.map((k, i) => parseSnapshotKey(k, `keys[${i}].`));
}

async function shotOf(ctx: BaselinesCtx, orgId: string, shot: BaselineSnapshot | undefined) {
  if (!shot) return null;
  return {
    id: shot.id,
    image_url: await imageUrl(ctx, orgId, shot.imageKey),
    fingerprint: JSON.parse(shot.envFingerprint),
    ignore: shot.ignore,
  };
}

async function reply(
  ctx: BaselinesCtx,
  owner: { orgId: string; diffLocation: DiffLocation },
  build: PickFor,
  keys: SnapshotKey[],
): Promise<Response> {
  const picked = await selectBaselines(ctx.db, build, new Set(keys.map(snapshotKeyOf)));
  const baselines = await Promise.all(
    keys.map(async (key) => {
      const b = picked.byKey.get(snapshotKeyOf(key));
      return {
        key,
        baseline: await shotOf(ctx, owner.orgId, b?.shot),
        // The id of the shot holding an undecided change: a shot identical to `baseline` carries
        // it, and one that differs is measured against `accepted` instead (ob 1712).
        carry: b?.carry ?? null,
        accepted: b?.carry ? await shotOf(ctx, owner.orgId, b.accepted) : null,
      };
    }),
  );
  // The baseline build's shots that no key asked about (ob 1732): what this build would remove.
  const removed = picked.removed.map(({ name, platform, browser, viewport, theme }) => ({
    name,
    platform,
    browser,
    viewport,
    theme,
  }));
  return Response.json({
    api_version: API_VERSION,
    diff_location: owner.diffLocation,
    baselines,
    removed,
  });
}

/** `POST /api/v1/builds/:id/baselines`: the pick for an open build, the same one its finalise makes. */
export async function buildBaselines(
  ctx: BaselinesCtx,
  buildId: string,
  body: unknown,
): Promise<Response> {
  const { build, ...owner } = await actorBuild(ctx.db, ctx.actor, buildId);
  return reply(ctx, owner, build, keysOf(body));
}

/**
 * `POST /api/v1/baselines`: the pick a build at this commit would get now, with nothing created
 * (for `check` and flake retries). A CI token asks for its project; a personal token names one.
 */
export async function previewBaselines(
  ctx: BaselinesCtx,
  projectId: string,
  body: unknown,
): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const git = parseNewBuild(body);
  const build: PickFor = {
    // No build has this id, so every build of the project is a candidate.
    id: "",
    projectId: project.id,
    createdAt: new Date(),
    branch: git.branch,
    mergeBaseSha: git.mergeBaseSha,
    ancestorShas: git.ancestorShas,
  };
  return reply(ctx, project, build, keysOf(body));
}
