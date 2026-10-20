import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import {
  MeasuredPanel,
  ReviewBar,
  SettingsPanel,
  SizeLine,
  SnapshotHeader,
} from "#/components/snapshot-panels";
import { SnapshotViewer } from "#/components/snapshot-viewer";
import { Page } from "#/components/ui";
import { useReviewKeys } from "#/lib/use-review-keys";
import { getSnapshotPage, reviewShot } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/builds/$buildId_/snapshots/$snapshotId")(
  {
    loader: ({ params }) =>
      getSnapshotPage({
        data: {
          projectId: params.projectId,
          buildId: params.buildId,
          snapshotId: params.snapshotId,
        },
      }),
    component: SnapshotPage,
  },
);

function SnapshotPage() {
  const { project, build, snapshot, images, diffOptions, position, total, previousId, nextId } =
    Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewable = build.status === "changes" || build.status === "passed";

  const go = useCallback(
    (id: string | null) => {
      if (!id) return;
      void navigate({
        to: "/projects/$projectId/builds/$buildId/snapshots/$snapshotId",
        params: { projectId: project.id, buildId: build.id, snapshotId: id },
      });
    },
    [navigate, project.id, build.id],
  );

  const decide = useCallback(
    (state: "accepted" | "rejected") => {
      if (!reviewable) return;
      setBusy(true);
      setError(null);
      reviewShot({ data: { projectId: project.id, snapshotId: snapshot.id, state } })
        .then(() => router.invalidate())
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [reviewable, project.id, snapshot.id, router],
  );

  useReviewKeys({ enabled: reviewable, nextId, previousId, go, decide });

  return (
    <Page title={`${project.name} · ${snapshot.name}`} wide>
      <SnapshotHeader
        project={project}
        build={build}
        snapshot={snapshot}
        position={position}
        total={total}
      />
      <SizeLine snapshot={snapshot} />
      <SnapshotViewer
        name={snapshot.name}
        mainUrl={images.main}
        branchUrl={images.branch}
        diffUrl={images.diff}
        result={snapshot.diffResult}
        removed={snapshot.diffStatus === "removed"}
      />
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <MeasuredPanel snapshot={snapshot} />
        <SettingsPanel snapshot={snapshot} options={diffOptions} />
      </div>
      <ReviewBar
        reviewable={reviewable}
        busy={busy}
        status={build.status}
        error={error}
        onAccept={() => decide("accepted")}
        onReject={() => decide("rejected")}
      />
    </Page>
  );
}
