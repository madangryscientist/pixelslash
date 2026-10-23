import { Breadcrumbs, ListLayout } from "@hackcove/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { BuildHeader } from "#/components/build-header";
import { BuildTimings } from "#/components/build-timings";
import { BuildSummary } from "#/components/build-summary";
import { TabBody, Tabs } from "#/components/build-shots";
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
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">
      {build.error}
      {project.diffLocation === "ci" && build.status === "errored" && (
        <span data-testid="rerun-ci" className="mt-1 block font-medium">
          This project diffs in CI, so the server cannot measure it again: re-run the CI job.
        </span>
      )}
      {project.diffLocation === "server" && build.status === "errored" && (
        <RerunErrored projectId={project.id} buildId={build.id} />
      )}
    </div>
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
        <BuildTimings build={build} />
        <BuildError project={project} build={build} />
        {error && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">
            {error}
          </p>
        )}
        {snapshots.length === 0 ? (
          <p className="text-slate-600">This build holds no snapshots yet.</p>
        ) : (
          <>
            <Tabs projectId={project.id} buildId={build.id} active={active} counts={counts} />
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
        <p className="text-sm text-slate-500">
          A rejection keeps the build failed until a new build arrives. New and removed shots are
          listed for review and never block a build.
        </p>
        <BuildOverrideChanges changes={thresholdChanges} />
      </ListLayout>
    </Page>
  );
}
