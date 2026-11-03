import { type BuildTwins, type TwinEntry, hasTwins, twinSourceLabel } from "#/lib/twins";

// The `twins` section of a build reply (PS-295), shaped in the API's snake_case.

function twinEntry(e: TwinEntry) {
  return {
    snapshot_id: e.snapshotId,
    name: e.name,
    theme: e.theme,
    platform: e.platform,
    device: e.device,
    viewport: e.viewport,
    has_metrics: e.hasMetrics,
    twins: e.twins.map((t) => ({
      snapshot_id: t.snapshotId,
      platform: t.platform,
      device: t.device,
      viewport: t.viewport,
      project_id: t.projectId,
      project_name: t.projectName,
      build_id: t.buildId,
      source: t.source.kind,
      source_label: twinSourceLabel(t.source),
      commit_sha: t.source.commitSha,
      has_metrics: t.hasMetrics,
    })),
    missing: e.missing,
  };
}

/**
 * The `twins` section of a build (PS-295): its shots paired with the same name and theme on the
 * other platforms, and the shots left unlinked. Absent when no other platform is in play, so a
 * web-only project's reply is the one it always was.
 */
export function twinsSection(t: BuildTwins) {
  if (!hasTwins(t)) return {};
  return {
    twins: {
      twin_project: t.twinProject && { id: t.twinProject.id, name: t.twinProject.name },
      linked: t.linked.map(twinEntry),
      unlinked: t.unlinked.map(twinEntry),
    },
  };
}
