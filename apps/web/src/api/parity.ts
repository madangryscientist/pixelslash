import { actorBuild } from "#/db/actor";
import { parityShotsOf } from "#/db/parity-columns";
import type { ParityColumn, ParityView } from "#/lib/parity-view";
import { twinSourceLabel } from "#/lib/twins";
import { buildParityView } from "#/server/parity-view";
import type { BlobStore } from "#/storage/blobs";
import { type ReadCtx, buildUrl, imageUrl, reply } from "./read";
import { causeJson } from "./twins-section";
import { BadRequest } from "./validate";

/**
 * The parity view over the API (PS-298): one snapshot key of a build on web, android and ios, the
 * metrics comparison of PS-296 and a similarity hint per native column. A read of stored shots and
 * metrics files; the score is a hint and feeds no status, check or count.
 */

export type ParityCtx = ReadCtx & { store: BlobStore };

const columnJson = (c: ParityColumn) =>
  c.kind === "missing"
    ? { kind: c.kind, platform: c.platform, line: c.line }
    : {
        kind: c.kind,
        platform: c.platform,
        device: c.device,
        viewport: c.viewport,
        label: c.label,
        snapshot_id: c.snapshotId,
        build_id: c.buildId,
        project_id: c.projectId,
        project_name: c.projectName,
        source: c.source.kind,
        source_label: twinSourceLabel(c.source),
        commit_sha: c.source.commitSha,
        scale: c.scale,
        size: c.size,
        physical_size: c.physical,
        image_url: c.imageUrl,
        has_metrics: c.hasMetrics,
        stale: c.stale !== null,
        stale_cause: c.stale && causeJson(c.stale),
        similarity: c.similarity && {
          against_snapshot_id: c.similarity.against?.snapshotId ?? null,
          score: c.similarity.score,
          text: c.similarity.text,
        },
      };

const side = (s: { snapshotId: string; platform: string; label: string }) => ({
  snapshot_id: s.snapshotId,
  platform: s.platform,
  label: s.label,
});

export function parityJson(view: ParityView) {
  const { metrics } = view;
  return {
    name: view.name,
    theme: view.theme,
    columns: view.columns.map(columnJson),
    metrics: {
      manifest: metrics.manifest,
      notice: metrics.notice,
      pairs: metrics.pairs.map((p) => ({
        a: side(p.a),
        b: side(p.b),
        status: p.status,
        lacks: p.lacks,
        mismatches: p.mismatches,
        declared: p.declared,
        tolerance: p.tolerance,
      })),
      raw_columns: metrics.rawColumns.map((c) => ({ ...side(c), measured: c.measured })),
      raw: metrics.raw.map((r) => ({ part: r.part, field: r.field, values: r.values })),
    },
  };
}

/**
 * `GET /api/v1/builds/:id/parity?name=…&theme=…`: the parity view of one key of the build. The
 * twins are the build's twin pairing (PS-295), so a CI token reaches its own project only, as on
 * the build's `twins` section. 404 when the build holds no shot under the key.
 */
export async function getParity(ctx: ParityCtx, buildId: string): Promise<Response> {
  const name = ctx.query.get("name");
  const theme = ctx.query.get("theme");
  if (!name || !theme) throw new BadRequest("name and theme are required");
  const { build, orgId } = await actorBuild(ctx.db, ctx.actor, buildId);
  const columns = await parityShotsOf(
    ctx.db,
    build.id,
    { name, theme },
    { crossProject: ctx.actor.kind !== "ci" },
  );
  const view = await buildParityView({
    columns,
    orgId,
    store: ctx.store,
    sign: async (key) => (await imageUrl(ctx, orgId, key)) ?? "",
  });
  const web = `${buildUrl(ctx, build.projectId, build.id)}/parity?${new URLSearchParams({ name, theme })}`;
  return reply({ ...parityJson(view), web_url: web });
}
