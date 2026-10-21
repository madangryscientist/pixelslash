import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Page, ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { formatDateTime, formatNumber } from "#/lib/format";
import { GROUP_LABEL, SNAPSHOT_GROUPS, type SnapshotGroup, groupOf } from "#/lib/snapshot-groups";
import { acceptBuild, getBuildPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/builds/$buildId")({
  loader: ({ params }) =>
    getBuildPage({ data: { projectId: params.projectId, buildId: params.buildId } }),
  component: BuildPage,
});

/** The measured change, in the words the reviewer needs; nothing invented. */
function measured(shot: SnapshotView): string {
  if (shot.diffStatus === "new") return "no baseline: not compared";
  if (shot.diffStatus === "removed") return "in the baseline only";
  if (shot.diffStatus === null) {
    return groupOf(shot) === "unmeasured" ? "not measured" : "not compared: needs a new baseline";
  }
  const result = shot.diffResult;
  if (!result) return "not compared";
  if (shot.diffStatus === "unchanged") return "no change";
  const boxes = result.regions.filter((region) => region.kind === "change").length;
  const changed = `${formatNumber(result.changedPixels)} px in ${boxes} box${boxes === 1 ? "" : "es"}`;
  if (result.sizeChanged) {
    const sizes = `${result.mainWidth}×${result.mainHeight} → ${result.branchWidth}×${result.branchHeight}`;
    return boxes > 0 ? `${changed} · size changed ${sizes}` : `size changed ${sizes}`;
  }
  return changed;
}

function BuildMeta({
  build,
  pending,
  total,
}: {
  build: BuildView["build"];
  pending: number;
  total: number;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
      <span className="font-mono">{build.commitSha.slice(0, 7)}</span>
      {build.prNumber !== null && <span>PR #{build.prNumber}</span>}
      <StatusBadge status={build.status} />
      <span className="text-neutral-500">{formatDateTime(build.createdAt)}</span>
      <span className="text-neutral-500">
        {pending === 0 ? "nothing pending" : `${pending} of ${total} pending`}
      </span>
    </div>
  );
}

function AcceptAll({
  pending,
  reviewable,
  onAccept,
}: {
  pending: number;
  reviewable: boolean;
  onAccept: () => Promise<void>;
}) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const accept = () => {
    setBusy(true);
    void onAccept().finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      disabled={!hydrated || busy || !reviewable || pending === 0}
      onClick={accept}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
    >
      Accept all
    </button>
  );
}

function GroupSection({
  projectId,
  buildId,
  group,
  rows,
}: {
  projectId: string;
  buildId: string;
  group: SnapshotGroup;
  rows: SnapshotView[];
}) {
  if (rows.length === 0) return null;
  return (
    <section data-testid={`group-${group}`} className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">
        {GROUP_LABEL[group]} <span className="text-neutral-500">({rows.length})</span>
      </h2>
      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
        {rows.map((shot) => (
          <li key={shot.id} data-testid="snapshot-row">
            <Link
              to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
              params={{ projectId, buildId, snapshotId: shot.id }}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-neutral-50"
            >
              <span className="font-medium">{shot.name}</span>
              <span className="text-sm text-neutral-500">
                {shot.platform} · {shot.browser} · {shot.viewport} · {shot.theme}
              </span>
              <span className="text-sm text-neutral-600">{measured(shot)}</span>
              <span className="ml-auto">
                <ReviewChip state={shot.reviewState} by={shot.reviewedBy} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BuildPage() {
  const { project, build, snapshots } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const pending = snapshots.filter((shot) => shot.reviewState === "pending").length;
  const reviewable = build.status === "changes" || build.status === "passed";
  const acceptAll = async () => {
    setError(null);
    try {
      await acceptBuild({ data: { projectId: project.id, buildId: build.id } });
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Page title={`${project.name} · ${build.branch}`} wide>
      <p className="mb-1 text-sm text-neutral-600">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="text-blue-700 hover:underline"
        >
          ← {project.name}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <BuildMeta build={build} pending={pending} total={snapshots.length} />
        <div className="mb-6 ml-auto">
          <AcceptAll pending={pending} reviewable={reviewable} onAccept={acceptAll} />
        </div>
      </div>
      {build.error && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
          {build.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
          {error}
        </p>
      )}
      {snapshots.length === 0 && (
        <p className="text-neutral-600">This build holds no snapshots yet.</p>
      )}
      {SNAPSHOT_GROUPS.map((group) => (
        <GroupSection
          key={group}
          projectId={project.id}
          buildId={build.id}
          group={group}
          rows={snapshots.filter((shot) => groupOf(shot) === group)}
        />
      ))}
      <p className="text-sm text-neutral-500">
        A rejection keeps the build failed until a new build arrives. New and removed shots are
        listed for review and never block a build.
      </p>
    </Page>
  );
}
