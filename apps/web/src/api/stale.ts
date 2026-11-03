import { actorProject } from "#/db/actor";
import { projectStale, staleScope } from "#/db/stale";
import { baselinePairs } from "#/db/stale-apply";
import { type StaleItem, type StalePlatform, staleLine } from "#/lib/stale";
import { type ReadCtx, buildUrl, reply } from "./read";
import { causeJson, twinEntry } from "./twins-section";
import { BadRequest } from "./validate";

/**
 * Stale twins over the API (PS-297): a native twin whose web side changed and was accepted, and
 * which nobody has accepted since. Derived on read from the reviews; nothing marks one fresh.
 */

const PLATFORMS: readonly StalePlatform[] = ["android", "ios"];

function itemJson(ctx: ReadCtx, item: StaleItem) {
  return {
    name: item.name,
    theme: item.theme,
    platform: item.platform,
    sentence: staleLine(item, buildUrl(ctx, item.cause.projectId, item.cause.buildId)),
    cause: causeJson(item.cause),
    shots: item.shots.map((s) => ({
      snapshot_id: s.snapshotId,
      build_id: s.buildId,
      project_id: s.projectId,
      device: s.device,
      viewport: s.viewport,
    })),
  };
}

/**
 * `GET /api/v1/projects/:id/stale[?platform=android|ios]`: the stale twins of the project and its
 * linked twin project. With a `platform` the reply also carries `baselines`, the accepted baseline
 * pairs of web and that platform in a build's `twins.linked` shape, for `parity --release`.
 */
export async function listStale(ctx: ReadCtx, projectId: string): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const asked = ctx.query.get("platform");
  const platform = PLATFORMS.find((p) => p === asked);
  if (asked !== null && platform === undefined)
    throw new BadRequest(`platform must be one of ${PLATFORMS.join(", ")}`);
  // A CI token reaches its own project only, as on a build's twins section.
  const crossProject = ctx.actor.kind !== "ci";
  const items = await projectStale(ctx.db, project.id, {
    crossProject,
    ...(platform ? { platform } : {}),
  });
  const body: Record<string, unknown> = {
    stale: items.map((i) => itemJson(ctx, i)),
    next_cursor: null,
  };
  if (platform) {
    const scope = await staleScope(ctx.db, project.id, crossProject);
    body.baselines = {
      platform,
      linked: (await baselinePairs(ctx.db, scope, platform)).map(twinEntry),
    };
  }
  return reply(body);
}
