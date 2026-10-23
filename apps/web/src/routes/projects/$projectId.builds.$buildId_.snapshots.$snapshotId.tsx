import { Breadcrumbs, Container, FullBleedLayout } from "@hackcove/ui";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { RegionNotesProvider } from "#/components/ai-notes";
import { DiffOverride } from "#/components/diff-override";
import { FlagPanel, useFlagDraft } from "#/components/detection-flag";
import { FlakePanel } from "#/components/flake";
import { EdgeWarning, IgnoreBoxes, useIgnoreDraft } from "#/components/ignore-boxes";
import { RerunShot } from "#/components/rerun";
import { ShortcutHelp, ViewerBar } from "#/components/snapshot-panels";
import { SidePanel } from "#/components/snapshot-side-panel";
import { SnapshotViewer } from "#/components/snapshot-viewer";
import { buildCrumb, orgCrumb, projectCrumb } from "#/components/crumbs";
import { Page } from "#/components/ui";
import { ignoreAreas } from "#/lib/ignore-areas";
import { shotLabeller } from "#/lib/shot-label";
import { skippedFlaky } from "#/lib/snapshot-groups";
import { useRefreshWhile } from "#/lib/use-refresh-while";
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

/** Go to another shot of the same build; null (the end of the walk) goes nowhere. */
function useWalk(projectId: string, buildId: string) {
  const navigate = useNavigate();
  return useCallback(
    (id: string | null) => {
      if (!id) return;
      void navigate({
        to: "/projects/$projectId/builds/$buildId/snapshots/$snapshotId",
        params: { projectId, buildId, snapshotId: id },
      });
    },
    [navigate, projectId, buildId],
  );
}

function DecisionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="border-b border-red-200 bg-red-50">
      <Container>
        <p role="alert" className="py-2 text-sm text-red-700">
          {error}
        </p>
      </Container>
    </div>
  );
}

/** The flag, flake and re-run panels under the side panel's options. */
function ShotPanels({
  data,
  flag,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  flag: ReturnType<typeof useFlagDraft>;
}) {
  const { project, build, snapshot } = data;
  return (
    <>
      <FlagPanel projectId={project.id} snapshotId={snapshot.id} flags={data.flags} draft={flag} />
      <FlakePanel
        projectId={project.id}
        snapshot={snapshot}
        flake={data.flake}
        skipped={skippedFlaky(snapshot)}
      />
      <RerunShot project={project} build={build} snapshot={snapshot} />
    </>
  );
}

/** The right-hand column: the side panel with its override, ignore-box and per-shot panels. */
function SideColumn({
  data,
  flag,
  ignore,
  reviewable,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  flag: ReturnType<typeof useFlagDraft>;
  ignore: ReturnType<typeof useIgnoreDraft>;
  reviewable: boolean;
}) {
  const { project, build, snapshot } = data;
  return (
    <SidePanel
      projectId={project.id}
      snapshot={snapshot}
      options={data.diffOptions}
      reviewable={reviewable}
      status={build.status}
      after={
        <>
          <DiffOverride {...data} />
          <IgnoreBoxes {...data} draft={ignore} />
        </>
      }
    >
      <ShotPanels data={data} flag={flag} />
    </SidePanel>
  );
}

function SnapshotPage() {
  const data = Route.useLoaderData();
  const { project, org, build, snapshot, images, previousId, nextId, names } = data;
  const reviewable = build.status === "changes" || build.status === "passed";
  const { busy, error, decide } = useDecision(project.id, snapshot.id, reviewable);
  const [help, setHelp] = useState(false);
  const flag = useFlagDraft(snapshot.id, data.flags, snapshot.diffResult !== null);
  const ignore = useIgnoreDraft(snapshot.id);
  const ignored = ignoreAreas(snapshot, data.uploadedIgnore, ignore.rect);
  const label = useMemo(() => shotLabeller(names)(snapshot.name), [names, snapshot.name]);
  useRefreshWhile(snapshot.aiPending);

  const go = useWalk(project.id, build.id);
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
    <Page bleed>
      <FullBleedLayout
        panel={<SideColumn data={data} flag={flag} ignore={ignore} reviewable={reviewable} />}
      >
        <ViewerBar
          {...data}
          breadcrumbs={
            <Breadcrumbs
              crumbs={[
                orgCrumb(org),
                projectCrumb(project),
                buildCrumb(project.id, build),
                snapshot.name,
              ]}
            />
          }
          label={label}
          reviewable={reviewable}
          busy={busy}
          actions={{
            onPrevious: previousId ? () => go(previousId) : null,
            onNext: nextId ? () => go(nextId) : null,
            onAccept: () => decide("accepted"),
            onReject: () => decide("rejected"),
            onFlag: flag.toggle,
            flagOpen: flag.open,
            onHelp: openHelp,
          }}
        />
        <DecisionError error={error} />
        <div className="min-w-0 space-y-3 p-4">
          <EdgeWarning result={snapshot.diffResult} />
          <RegionNotesProvider notes={snapshot.aiReview?.regions ?? []}>
            <SnapshotViewer
              name={snapshot.name}
              mainUrl={images.main}
              branchUrl={images.branch}
              diffUrl={images.diff}
              result={snapshot.diffResult}
              removed={snapshot.diffStatus === "removed"}
              marks={flag.marks}
              onDraw={flag.onDraw ?? ignore.onDraw}
              ignored={ignored}
            />
          </RegionNotesProvider>
        </div>
      </FullBleedLayout>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </Page>
  );
}
