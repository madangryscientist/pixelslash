import { Breadcrumbs, Callout, FullBleedLayout, Stack } from "@hackcove/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { RegionNotesProvider } from "#/components/ai-notes";
import { CompositionFocus, CompositionPanel } from "#/components/composition";
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

/**
 * Accept or reject the shot on screen. An accept that lands moves the reviewer on to the next shot
 * still awaiting one, or to the build page when none is left; the next shot is read after the
 * decision, because this shot's loaded data predates decisions made on the others since it was
 * opened. A reject always goes to the build page: it fails the build, and a failed build takes no
 * more decisions, so the next shot would be a dead screen. Only a refused decision is an error.
 */
function useDecision(data: ReturnType<typeof Route.useLoaderData>, reviewable: boolean) {
  const { project, build, snapshot } = data;
  const projectId = project.id;
  const buildId = build.id;
  const snapshotId = snapshot.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = useWalk(projectId, buildId);
  const navigate = useNavigate();
  const decide = useCallback(
    (state: "accepted" | "rejected") => {
      if (!reviewable) return;
      setBusy(true);
      setError(null);
      const toBuild = () =>
        void navigate({
          to: "/projects/$projectId/builds/$buildId",
          params: { projectId, buildId },
        });
      const advance = () =>
        getSnapshotPage({ data: { projectId, buildId, snapshotId } }).then(
          ({ build: fresh, nextToReviewId }) => {
            // Another reviewer's reject can land between this accept and the read: the build is failed then.
            const stillDecidable = fresh.status === "changes" || fresh.status === "passed";
            if (nextToReviewId && stillDecidable) go(nextToReviewId);
            else toBuild();
          },
          toBuild,
        );
      reviewShot({ data: { projectId, snapshotId, state } })
        .then(
          () => (state === "rejected" ? toBuild() : advance()),
          (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    },
    [reviewable, projectId, buildId, snapshotId, go, navigate],
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
    <Callout tone="danger" banner role="alert">
      {error}
    </Callout>
  );
}

/**
 * Mark flaky shows while no flake is open; the others need a server diff of a shot still there
 * (the guards at the top of RerunShot, DiffOverride and IgnoreBoxes: keep this in step with them).
 */
const hasTools = ({ flake, project, snapshot }: ReturnType<typeof Route.useLoaderData>) =>
  !flake || (project.diffLocation === "server" && snapshot.diffStatus !== "removed");

/** The side panel's tools: re-run, mark flaky (when no flake is open), thresholds and ignore areas. */
function ShotTools({
  data,
  ignore,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  ignore: ReturnType<typeof useIgnoreDraft>;
}) {
  const { project, build, snapshot } = data;
  return (
    <>
      <RerunShot project={project} build={build} snapshot={snapshot} />
      {!data.flake && <Flake data={data} />}
      <DiffOverride {...data} />
      <IgnoreBoxes {...data} draft={ignore} />
    </>
  );
}

function Flake({ data }: { data: ReturnType<typeof Route.useLoaderData> }) {
  return (
    <FlakePanel
      projectId={data.project.id}
      snapshot={data.snapshot}
      flake={data.flake}
      skipped={skippedFlaky(data.snapshot)}
    />
  );
}

/** The right-hand column: the side panel, the flag and an open flake on top, the rest under Tools. */
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
      tools={hasTools(data) ? <ShotTools data={data} ignore={ignore} /> : null}
    >
      <FlagPanel projectId={project.id} snapshotId={snapshot.id} flags={data.flags} draft={flag} />
      {data.flake && <Flake data={data} />}
    </SidePanel>
  );
}

function SnapshotPage() {
  const data = Route.useLoaderData();
  const { project, org, build, snapshot, images, previousId, nextId, names } = data;
  const reviewable = build.status === "changes" || build.status === "passed";
  const { busy, error, decide } = useDecision(data, reviewable);
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
        <div className="p-4">
          <Stack gap="sm">
            <EdgeWarning result={snapshot.diffResult} />
            <CompositionFocus>
              <RegionNotesProvider notes={snapshot.aiReview?.regions ?? []}>
                <SnapshotViewer
                  name={snapshot.name}
                  mainUrl={images.main}
                  branchUrl={images.branch}
                  diffUrl={images.diff}
                  result={snapshot.diffResult}
                  removed={snapshot.diffStatus === "removed"}
                  composition={snapshot.composition}
                  marks={flag.marks}
                  onDraw={flag.onDraw ?? ignore.onDraw}
                  ignored={ignored}
                />
              </RegionNotesProvider>
              <CompositionPanel composition={snapshot.composition} />
            </CompositionFocus>
          </Stack>
        </div>
      </FullBleedLayout>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </Page>
  );
}
