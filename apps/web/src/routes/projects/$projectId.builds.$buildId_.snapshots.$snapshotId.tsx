import { Breadcrumbs, Callout, FullBleedLayout, Stack } from "@hackcove/ui-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { RegionNotesProvider } from "#/components/ai-notes";
import { A11yPanel } from "#/components/a11y";
import { CompositionFocus, CompositionPanel } from "#/components/composition";
import { DiffOverride } from "#/components/diff-override";
import { FlagPanel, useFlagDraft } from "#/components/detection-flag";
import { FlakePanel } from "#/components/flake";
import { EdgeWarning, IgnoreBoxes, useIgnoreDraft } from "#/components/ignore-boxes";
import { RerunShot } from "#/components/rerun";
import type { PanelToggle } from "#/components/snapshot-controls";
import { ShortcutHelp, StickyRail, ViewerBar } from "#/components/snapshot-panels";
import { linkToBuild } from "#/components/snapshot-base-link";
import { SidePanel } from "#/components/snapshot-side-panel";
import { SnapshotViewer, useViewState, type ViewState } from "#/components/snapshot-viewer";
import { buildCrumb, orgCrumb, projectCrumb } from "#/components/crumbs";
import { Page } from "#/components/ui";
import { formatNumber, formatPercent } from "#/lib/format";
import { ignoreAreas } from "#/lib/ignore-areas";
import { shotLabeller } from "#/lib/shot-label";
import { skippedFlaky } from "#/lib/snapshot-groups";
import { type DecisionState, useDecision } from "#/lib/use-decision";
import { useRefreshWhile } from "#/lib/use-refresh-while";
import { useReviewKeys } from "#/lib/use-review-keys";
import { useWalk } from "#/lib/use-walk";
import { usePanelFold } from "#/lib/use-panel-fold";
import { basesOf } from "#/lib/viewer-bases";
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

/** The decision hook, wired to this shot's server call and routes. */
function useShotDecision(data: ReturnType<typeof Route.useLoaderData>, reviewable: boolean) {
  const projectId = data.project.id;
  const buildId = data.build.id;
  const snapshotId = data.snapshot.id;
  const go = useWalk(projectId, buildId);
  const navigate = useNavigate();
  const review = useCallback(
    (state: DecisionState) =>
      // Only an accept moves on to another shot, so only an accept asks where to.
      reviewShot({ data: { projectId, snapshotId, state, next: state === "accepted" } }),
    [projectId, snapshotId],
  );
  const toBuild = useCallback(
    () =>
      void navigate({
        to: "/projects/$projectId/builds/$buildId",
        params: { projectId, buildId },
      }),
    [navigate, projectId, buildId],
  );
  return useDecision({ reviewable, review, go, toBuild });
}

function DecisionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Callout tone="danger" role="alert">
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
    <StickyRail>
      <SidePanel
        projectId={project.id}
        buildId={build.id}
        snapshot={snapshot}
        options={data.diffOptions}
        reviewable={reviewable}
        status={build.status}
        metrics={data.metrics}
        twins={data.twins}
        tools={hasTools(data) ? <ShotTools data={data} ignore={ignore} /> : null}
      >
        <FlagPanel
          projectId={project.id}
          snapshotId={snapshot.id}
          flags={data.flags}
          draft={flag}
        />
        {data.flake && <Flake data={data} />}
      </SidePanel>
    </StickyRail>
  );
}

function ShotCrumbs({ data }: { data: ReturnType<typeof Route.useLoaderData> }) {
  const { org, project, build, snapshot } = data;
  return (
    <Breadcrumbs
      crumbs={[orgCrumb(org), projectCrumb(project), buildCrumb(project.id, build), snapshot.name]}
    />
  );
}

/** The centre column: the viewer, and the composition and accessibility findings under it. */
function ViewerStage({
  data,
  error,
  flag,
  ignore,
  ignored,
  view,
  panel,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  error: string | null;
  flag: ReturnType<typeof useFlagDraft>;
  ignore: ReturnType<typeof useIgnoreDraft>;
  ignored: ReturnType<typeof ignoreAreas>;
  view: ViewState;
  panel: PanelToggle | null;
}) {
  const { snapshot, images, project, build } = data;
  const bases = basesOf(
    { branch: build.branch, baselineBuild: data.baselineBuild, snapshot, images },
    { number: formatNumber, percent: formatPercent },
    linkToBuild(project.id),
  );
  return (
    <Stack gap="sm">
      <DecisionError error={error} />
      <EdgeWarning result={snapshot.diffResult} />
      <CompositionFocus>
        <RegionNotesProvider notes={snapshot.aiReview?.regions ?? []}>
          <SnapshotViewer
            snapshotId={snapshot.id}
            bases={bases}
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
            view={view}
            panel={panel}
          />
        </RegionNotesProvider>
        <CompositionPanel composition={snapshot.composition} />
        <A11yPanel diff={snapshot.a11yDiff} />
      </CompositionFocus>
    </Stack>
  );
}

function SnapshotPage() {
  const data = Route.useLoaderData();
  const { project, build, snapshot, previousId, nextId, names } = data;
  const reviewable = build.status === "changes" || build.status === "passed";
  const { busy, error, decide } = useShotDecision(data, reviewable);
  const [help, setHelp] = useState(false);
  const flag = useFlagDraft(snapshot.id, data.flags, snapshot.diffResult !== null);
  const ignore = useIgnoreDraft(snapshot.id);
  const ignored = ignoreAreas(snapshot, data.uploadedIgnore, ignore.rect);
  const view = useViewState();
  // The flag form and the ignore tools live in the panel, so it stays while they are in use.
  const { folded, toggle } = usePanelFold(
    view,
    flag.open || ignore.drawing || ignore.rect !== null,
  );
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

  const crumbs = <ShotCrumbs data={data} />;
  return (
    <Page bleed>
      {/* On a phone the breadcrumbs scroll away above the bar; from sm they sit in it. */}
      <div className="px-4 pt-2 sm:hidden">{crumbs}</div>
      <FullBleedLayout
        padded
        bar={
          <ViewerBar
            {...data}
            breadcrumbs={crumbs}
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
        }
        panelLabel="Review panel"
        panel={
          folded ? null : (
            <SideColumn data={data} flag={flag} ignore={ignore} reviewable={reviewable} />
          )
        }
      >
        <ViewerStage
          data={data}
          error={error}
          flag={flag}
          ignore={ignore}
          ignored={ignored}
          view={view}
          panel={toggle}
        />
      </FullBleedLayout>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </Page>
  );
}
