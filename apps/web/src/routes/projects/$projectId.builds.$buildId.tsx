import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { BuildHeader } from "#/components/build-header";
import { BuildSummary } from "#/components/build-summary";
import { TabBody, Tabs } from "#/components/build-shots";
import { buildCrumbLabel, orgCrumb, projectCrumb } from "#/components/crumbs";
import { BuildOverrideChanges } from "#/components/override-trail";
import { RerunErrored } from "#/components/rerun";
import { Page } from "#/components/ui";
import { BUILD_TABS, type BuildTab, defaultTab, setsBaseline, tabCounts } from "#/lib/build-tabs";
import { awaitsDecision } from "#/lib/snapshot-groups";
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
    <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
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

function BuildPage() {
  const { project, org, build, snapshots, thumbs, firstBuild, thresholdChanges, modelConfigured } =
    Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const counts = tabCounts(snapshots);
  const baseline = setsBaseline(firstBuild, snapshots);
  const active = search.tab ?? defaultTab(counts);
  // Only a shot holding a change blocks a build (verdictOf); new, removed and unchanged ones do not
  // need a decision, unless an unchanged one carries the branch's open change (ob 1712).
  const toReview = snapshots.filter(awaitsDecision).length;
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
    <Page
      title={`${project.name} · ${build.branch}`}
      crumbs={[orgCrumb(org), projectCrumb(project), buildCrumbLabel(build)]}
      wide
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
          />
        )}
      </BuildHeader>
      <BuildError project={project} build={build} />
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
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
    </Page>
  );
}
