import {
  Body,
  Breadcrumbs,
  Callout,
  Cluster,
  Code,
  ListLayout,
  MetaList,
  SectionHeading,
  Stack,
  TextLink,
} from "@hackcove/ui";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { MainGroups } from "#/components/branch-main-groups";
import { BranchMetrics } from "#/components/branch-metrics";
import { BuildBrief } from "#/components/build-brief";
import {
  type BranchMode,
  ChangeSummary,
  MainSummaryBox,
  ModeTabs,
} from "#/components/branch-review";
import { TabBody } from "#/components/build-shots";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { Page, StatusBadge } from "#/components/ui";
import {
  type MainSummary,
  againstMainLines,
  mainSummary,
  sinceLastBuildLines,
} from "#/lib/branch-review";
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

type Loaded = ReturnType<typeof Route.useLoaderData>;

/** The newest build on the branch, and where the branch left main. */
function BranchMeta({
  project,
  build,
  buildCount,
}: Pick<Loaded, "project" | "build" | "buildCount">) {
  return (
    <Cluster gap="xs" wrap data-testid="branch-meta">
      <Body tone="muted">newest build</Body>
      <TextLink
        mono
        data-testid="branch-head"
        render={(props) => (
          <Link
            to="/projects/$projectId/builds/$buildId"
            params={{ projectId: project.id, buildId: build.id }}
            {...props}
          />
        )}
      >
        {short(build.commitSha)}
      </TextLink>
      {build.prNumber !== null && <Body>PR #{build.prNumber}</Body>}
      <StatusBadge status={build.status} />
      <MetaList>
        {formatDateTime(build.createdAt)}
        {`${buildCount} build${buildCount === 1 ? "" : "s"} on this branch`}
        {build.mergeBaseSha && (
          <>
            merge-base with <Code>{project.defaultBranch}</Code>:{" "}
            <Code>{short(build.mergeBaseSha)}</Code>
          </>
        )}
      </MetaList>
    </Cluster>
  );
}

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
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), projectCrumb(project), build.branch]} />}
        title={`${project.name} · ${build.branch}`}
      >
        <BranchMeta project={project} build={build} buildCount={buildCount} />
        <BuildBrief brief={build.brief} />
        <BranchMetrics metrics={data.metrics} />
        <MainSummaryBox summary={summary} status={build.status} />
        <ModeTabs projectId={project.id} branch={build.branch} active={mode} />
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        {mode === "main" ? (
          <AgainstMain
            projectId={project.id}
            buildId={build.id}
            defaultBranch={project.defaultBranch}
            shots={againstMain}
            summary={summary}
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
      </ListLayout>
    </Page>
  );
}

/** The final review: every shot that differs from main, by what still stops a merge. */
function AgainstMain({
  projectId,
  buildId,
  defaultBranch,
  shots,
  summary,
  thumbs,
  reviewable,
  onReview,
}: Parameters<typeof MainGroups>[0] & { defaultBranch: string; summary: MainSummary }) {
  return (
    <Stack as="section" data-testid="mode-body-main">
      <Body as="p" tone="muted">
        Everything this branch changes, measured from the accepted shot at the merge-base. This is
        the final review before merging.
      </Body>
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
      <Body as="p" tone="muted">
        Older builds made before against-main measuring show &ldquo;not measured against main&rdquo;
        and are not counted. &ldquo;Ready to merge&rdquo; only reads the review states above; it is
        not an approval of its own.
      </Body>
    </Stack>
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
    <Stack as="section" data-testid="mode-body-since">
      <Body as="p" tone="muted">
        {previous
          ? `What build ${head} changed compared with build ${previous} on this branch. The same view as the build page.`
          : `Build ${head} is the branch's first build, so it is compared with the accepted shots it started from. The same view as the build page.`}
      </Body>
      <ChangeSummary
        title={`What build ${head} changes`}
        detail={`${lines.length} shot${lines.length === 1 ? "" : "s"}${previous ? ` since build ${previous}` : ""}`}
        lines={lines}
        empty="Nothing changed since the last build."
      />
      {BUILD_TABS.filter((tab) => counts[tab.id] > 0).map((tab) => (
        <Stack key={tab.id} gap="xs" data-testid={`since-${tab.id}`}>
          {/* The removed and not-measured lists head themselves, by group. */}
          {(tab.id === "changed" || tab.id === "new" || tab.id === "unchanged") && (
            <SectionHeading>
              {tab.label} <Body tone="muted">({counts[tab.id]})</Body>
            </SectionHeading>
          )}
          <TabBody
            projectId={projectId}
            buildId={buildId}
            tab={tab.id}
            snapshots={snapshots}
            thumbs={thumbs}
            baseline={baseline}
          />
        </Stack>
      ))}
    </Stack>
  );
}
