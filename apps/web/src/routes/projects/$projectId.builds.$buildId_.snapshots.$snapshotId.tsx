import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ShortcutHelp, ViewerBar } from "#/components/snapshot-panels";
import { SidePanel } from "#/components/snapshot-side-panel";
import { SnapshotViewer } from "#/components/snapshot-viewer";
import { buildCrumb, orgCrumb, projectCrumb } from "#/components/crumbs";
import { Page } from "#/components/ui";
import { shotLabeller } from "#/lib/shot-label";
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

/** Accept or reject the shot on screen, then reload the page's data to show the decision. */
function useDecision(projectId: string, snapshotId: string, reviewable: boolean) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = useCallback(
    (state: "accepted" | "rejected") => {
      if (!reviewable) return;
      setBusy(true);
      setError(null);
      reviewShot({ data: { projectId, snapshotId, state } })
        .then(() => router.invalidate())
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [reviewable, projectId, snapshotId, router],
  );
  return { busy, error, decide };
}

function SnapshotPage() {
  const data = Route.useLoaderData();
  const { project, org, build, snapshot, images, previousId, nextId, names } = data;
  const navigate = useNavigate();
  const reviewable = build.status === "changes" || build.status === "passed";
  const { busy, error, decide } = useDecision(project.id, snapshot.id, reviewable);
  const [help, setHelp] = useState(false);
  const label = useMemo(() => shotLabeller(names)(snapshot.name), [names, snapshot.name]);

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
  const openHelp = useCallback(() => setHelp(true), []);
  useReviewKeys({
    canDecide: reviewable,
    nextId,
    previousId,
    go,
    decide,
    help: openHelp,
    helpOpen: help,
  });

  return (
    <Page
      title={`${project.name} · ${snapshot.name}`}
      crumbs={[orgCrumb(org), projectCrumb(project), buildCrumb(project.id, build), snapshot.name]}
      full
    >
      <ViewerBar
        {...data}
        label={label}
        reviewable={reviewable}
        busy={busy}
        actions={{
          onPrevious: previousId ? () => go(previousId) : null,
          onNext: nextId ? () => go(nextId) : null,
          onAccept: () => decide("accepted"),
          onReject: () => decide("rejected"),
          onHelp: openHelp,
        }}
      />
      {error && (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 p-4">
          <SnapshotViewer
            name={snapshot.name}
            mainUrl={images.main}
            branchUrl={images.branch}
            diffUrl={images.diff}
            result={snapshot.diffResult}
            removed={snapshot.diffStatus === "removed"}
          />
        </div>
        <SidePanel
          snapshot={snapshot}
          options={data.diffOptions}
          reviewable={reviewable}
          status={build.status}
        />
      </div>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </Page>
  );
}
