import { Body, BodyStrong, Breadcrumbs, Callout, ListLayout, Stack } from "@hackcove/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { BuildBrief } from "#/components/build-brief";
import { BuildHeader } from "#/components/build-header";
import { BuildTimings } from "#/components/build-timings";
import { BuildSummary } from "#/components/build-summary";
import { BuildTabs, TabBody } from "#/components/build-shots";
import { buildCrumbLabel, orgCrumb, projectCrumb } from "#/components/crumbs";
import { BuildOverrideChanges } from "#/components/override-trail";
import { RerunErrored } from "#/components/rerun";
import { Page } from "#/components/ui";
import { BUILD_TABS, type BuildTab, defaultTab, setsBaseline, tabCounts } from "#/lib/build-tabs";
import { awaitsDecision } from "#/lib/snapshot-groups";
import { useRefreshWhile } from "#/lib/use-refresh-while";
import { acceptBuild, getBuildPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/builds/$buildId")({
  validateSearch: (search: Record<string, unknown>): { tab?: BuildTab } => {
    const tab = BUILD_TABS.find((candidate) => candidate.id === search.tab);
    return tab ? { tab: tab.id } : {};
  },
  loader: ({ params }) =>
    getBuildPage({ data: { projectId: params.projectId, buildId: params.buildId } }),
  component: BuildPage,
});

type Loaded = ReturnType<typeof Route.useLoaderData>;

/** Why the build has no verdict, and how to measure it again. */
function BuildError({ project, build }: Pick<Loaded, "project" | "build">) {
  if (!build.error) return null;
  return (
    <Callout tone="danger" role="alert">
      <Stack gap="xs">
        <span>{build.error}</span>
        {project.diffLocation === "ci" && build.status === "errored" && (
          <BodyStrong as="p" tone="danger" data-testid="rerun-ci">
            This project diffs in CI, so the server cannot measure it again: re-run the CI job.
          </BodyStrong>
        )}
        {project.diffLocation === "server" && build.status === "errored" && (
          <RerunErrored projectId={project.id} buildId={build.id} />
        )}
      </Stack>
    </Callout>
  );
}

/** Accept every shot of the build, and why it could not be. */
function useAcceptAll(projectId: string, buildId: string) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const acceptAll = async () => {
    setError(null);
    try {
      await acceptBuild({ data: { projectId, buildId } });
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return { error, acceptAll };
}

/** What a decision does to the build, under the shots. */
function RejectionNote() {
  return (
    <Body as="p" tone="muted">
      A rejection keeps the build failed until a new build arrives. New and removed shots are listed
      for review and never block a build.
    </Body>
  );
}

/** The "This run" card (PS-233), from the page's own data. */
function RunCard() {
  const { project, build, snapshots, recaptures } = Route.useLoaderData();
  return (
    <BuildTimings
      build={build}
      shots={snapshots}
      defaultBranch={project.defaultBranch}
      recaptures={recaptures}
    />
  );
}

function BuildPage() {
  const {
    project,
    org,
    build,
    snapshots,
    summaryPending,
    thumbs,
    firstBuild,
    thresholdChanges,
    modelConfigured,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const counts = tabCounts(snapshots);
  const baseline = setsBaseline(firstBuild, snapshots);
  const active = search.tab ?? defaultTab(counts);
  // Only a shot holding a change blocks a build (verdictOf); new, removed and unchanged ones do not
  // need a decision, unless an unchanged one carries the branch's open change (ob 1712).
  const toReview = snapshots.filter(awaitsDecision).length;
  useRefreshWhile(summaryPending || snapshots.some((shot) => shot.aiPending));
  const reviewable = build.status === "changes" || build.status === "passed";
  const { error, acceptAll } = useAcceptAll(project.id, build.id);
  return (
    <Page>
      <ListLayout
        breadcrumbs={
          <Breadcrumbs crumbs={[orgCrumb(org), projectCrumb(project), buildCrumbLabel(build)]} />
        }
        title={`${project.name} · ${build.branch}`}
      >
        <BuildHeader
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          build={build}
          snapshots={snapshots}
          toReview={toReview}
          reviewable={reviewable}
          onAccept={acceptAll}
          baseline={baseline}
        >
          <BuildBrief brief={build.brief} />
          {build.branch !== project.defaultBranch && (
            <BuildSummary
              projectId={project.id}
              build={build}
              snapshots={snapshots}
              modelConfigured={modelConfigured}
              pending={summaryPending}
            />
          )}
        </BuildHeader>
        <RunCard />
        <BuildError project={project} build={build} />
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        {snapshots.length === 0 ? (
          <Body as="p" tone="muted">
            This build holds no snapshots yet.
          </Body>
        ) : (
          <>
            <BuildTabs projectId={project.id} buildId={build.id} active={active} counts={counts} />
            <TabBody
              key={active}
              projectId={project.id}
              buildId={build.id}
              tab={active}
              snapshots={snapshots}
              thumbs={thumbs}
              baseline={baseline}
            />
          </>
        )}
        <RejectionNote />
        <BuildOverrideChanges changes={thresholdChanges} />
      </ListLayout>
    </Page>
  );
}
