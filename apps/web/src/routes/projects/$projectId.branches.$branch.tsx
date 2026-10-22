import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  type BranchMode,
  ChangeSummary,
  MainGroups,
  MainSummaryBox,
  ModeTabs,
} from "#/components/branch-review";
import { TabBody } from "#/components/build-shots";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { Page, StatusBadge } from "#/components/ui";
import { againstMainLines, mainSummary, sinceLastBuildLines } from "#/lib/branch-review";
import { BUILD_TABS, setsBaseline, tabCounts } from "#/lib/build-tabs";
import { formatDateTime } from "#/lib/format";
import { getBranchPage } from "#/server/branch";
import { reviewShot } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/branches/$branch")({
  validateSearch: (search: Record<string, unknown>): { mode?: "since" } =>
    search.mode === "since" ? { mode: "since" } : {},
  loader: ({ params }) =>
    getBranchPage({ data: { projectId: params.projectId, branch: params.branch } }),
  component: BranchPage,
});

const short = (sha: string) => sha.slice(0, 7);

function BranchPage() {
  const data = Route.useLoaderData();
  const { project, org, build, snapshots, againstMain, thumbs, previous, buildCount } = data;
  const mode: BranchMode = Route.useSearch().mode ?? "main";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const reviewable = build.status === "changes" || build.status === "passed";
  const summary = mainSummary(againstMain, reviewable);
  const onReview = async (snapshotId: string, state: "accepted" | "rejected") => {
    setError(null);
    try {
      await reviewShot({ data: { projectId: project.id, snapshotId, state } });
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Page
      title={`${project.name} · ${build.branch}`}
      crumbs={[orgCrumb(org), projectCrumb(project), build.branch]}
      wide
    >
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm" data-testid="branch-meta">
        <span className="text-slate-500">newest build</span>
        <Link
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId: project.id, buildId: build.id }}
          className="font-mono text-violet-700 hover:underline"
          data-testid="branch-head"
        >
          {short(build.commitSha)}
        </Link>
        {build.prNumber !== null && <span>PR #{build.prNumber}</span>}
        <StatusBadge status={build.status} />
        <span className="text-slate-500">{formatDateTime(build.createdAt)}</span>
        <span className="text-slate-500">
          {buildCount} build{buildCount === 1 ? "" : "s"} on this branch
        </span>
        {build.mergeBaseSha && (
          <span className="text-slate-500">
            · merge-base with <code>{project.defaultBranch}</code>:{" "}
            <code>{short(build.mergeBaseSha)}</code>
          </span>
        )}
      </div>
      <MainSummaryBox summary={summary} status={build.status} />
      <ModeTabs projectId={project.id} branch={build.branch} active={mode} />
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
          {error}
        </p>
      )}
      {mode === "main" ? (
        <AgainstMain
          projectId={project.id}
          buildId={build.id}
          defaultBranch={project.defaultBranch}
          shots={againstMain}
          thumbs={thumbs}
          reviewable={reviewable}
          onReview={onReview}
        />
      ) : (
        <SinceLastBuild
          projectId={project.id}
          buildId={build.id}
          head={short(build.commitSha)}
          previous={previous ? short(previous.commitSha) : null}
          snapshots={snapshots}
          thumbs={thumbs}
          baseline={setsBaseline(data.firstBuild, snapshots)}
        />
      )}
    </Page>
  );
}

/** The final review: every shot that differs from main, by what still stops a merge. */
function AgainstMain({
  projectId,
  buildId,
  defaultBranch,
  shots,
  thumbs,
  reviewable,
  onReview,
}: Parameters<typeof MainGroups>[0] & { defaultBranch: string }) {
  const summary = mainSummary(shots, reviewable);
  return (
    <section data-testid="mode-body-main">
      <p className="mb-4 text-sm text-slate-600">
        Everything this branch changes, measured from the accepted shot at the merge-base. This is
        the final review before merging.
      </p>
      <ChangeSummary
        title="What this branch changes"
        detail={`${summary.changed} shot${summary.changed === 1 ? "" : "s"} · ${
          summary.waiting + summary.rejected
        } still need a look`}
        lines={againstMainLines(shots)}
        empty={`Nothing on this branch differs from ${defaultBranch}'s accepted shots.`}
      />
      <MainGroups
        projectId={projectId}
        buildId={buildId}
        shots={shots}
        thumbs={thumbs}
        reviewable={reviewable}
        onReview={onReview}
      />
      <p className="text-sm text-slate-500">
        Older builds made before against-main measuring show &ldquo;not measured against main&rdquo;
        and are not counted. &ldquo;Ready to merge&rdquo; only reads the review states above; it is
        not an approval of its own.
      </p>
    </section>
  );
}

/** The head build exactly as its build page groups it, every non-empty tab in turn. */
function SinceLastBuild({
  projectId,
  buildId,
  head,
  previous,
  snapshots,
  thumbs,
  baseline,
}: {
  projectId: string;
  buildId: string;
  head: string;
  previous: string | null;
  snapshots: Parameters<typeof TabBody>[0]["snapshots"];
  thumbs: Record<string, string>;
  baseline: boolean;
}) {
  const counts = tabCounts(snapshots);
  const lines = sinceLastBuildLines(snapshots);
  return (
    <section data-testid="mode-body-since">
      <p className="mb-4 text-sm text-slate-600">
        {previous
          ? `What build ${head} changed compared with build ${previous} on this branch. The same view as the build page.`
          : `Build ${head} is the branch's first build, so it is compared with the accepted shots it started from. The same view as the build page.`}
      </p>
      <ChangeSummary
        title={`What build ${head} changes`}
        detail={`${lines.length} shot${lines.length === 1 ? "" : "s"}${previous ? ` since build ${previous}` : ""}`}
        lines={lines}
        empty="Nothing changed since the last build."
      />
      {BUILD_TABS.filter((tab) => counts[tab.id] > 0).map((tab) => (
        <div key={tab.id} data-testid={`since-${tab.id}`}>
          {/* The removed and not-measured lists head themselves, by group. */}
          {(tab.id === "changed" || tab.id === "new" || tab.id === "unchanged") && (
            <h2 className="mb-2 text-lg font-semibold">
              {tab.label} <span className="text-slate-500">({counts[tab.id]})</span>
            </h2>
          )}
          <div className="mb-8">
            <TabBody
              projectId={projectId}
              buildId={buildId}
              tab={tab.id}
              snapshots={snapshots}
              thumbs={thumbs}
              baseline={baseline}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
