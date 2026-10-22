import { Link, createFileRoute } from "@tanstack/react-router";
import { Body, buttonClass } from "@hackcove/ui";
import { MixBar, ToReview, stripeOf } from "#/components/build-mix";
import { CopyLine } from "#/components/copy-button";
import { orgCrumb } from "#/components/crumbs";
import { Step } from "#/components/org-empty";
import { Page, StatusBadge, useHydrated } from "#/components/ui";
import type { BuildSummary } from "#/db/review";
import { formatRelative } from "#/lib/format";
import { getProjectPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: ({ params }) => getProjectPage({ data: { projectId: params.projectId } }),
  component: ProjectPage,
});

const COLUMNS = "lg:grid-cols-[1.4fr_110px_1.6fr_120px_92px]";
const HEAD = "text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

function ProjectPage() {
  const { project, org, builds, now, serverUrl } = Route.useLoaderData();
  const hydrated = useHydrated();
  return (
    <Page title={project.name} crumbs={[orgCrumb(org), project.name]} wide>
      <div className="mb-4 flex items-center justify-between gap-4">
        <Body as="p">
          {builds.length === 0
            ? "No builds yet."
            : `Builds newest first. ${builds.length} in this project.`}
        </Body>
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId: project.id }}
          className={buttonClass("outline")}
        >
          Settings
        </Link>
      </div>
      {builds.length === 0 ? (
        <EmptyProject projectId={project.id} serverUrl={serverUrl} hydrated={hydrated} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div
            aria-hidden="true"
            className={`hidden items-center gap-4 bg-slate-50 py-2.5 pr-4 pl-5 lg:grid ${COLUMNS} ${HEAD}`}
          >
            <span>Branch</span>
            <span>Status</span>
            <span>Snapshots</span>
            <span>Review</span>
            <span>When</span>
          </div>
          <ul>
            {builds.map((build) => (
              <BuildRow
                key={build.id}
                projectId={project.id}
                defaultBranch={project.defaultBranch}
                build={build}
                now={now}
              />
            ))}
          </ul>
        </div>
      )}
    </Page>
  );
}

function BuildRow({
  projectId,
  defaultBranch,
  build,
  now,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
  now: Date;
}) {
  return (
    <li
      data-testid="build-row"
      className={`relative grid items-center gap-x-4 gap-y-2 border-t border-slate-100 py-3.5 pr-4 pl-5 first:border-t-0 hover:bg-slate-50 ${COLUMNS}`}
    >
      <span
        aria-hidden="true"
        style={{ background: stripeOf(build) }}
        className="absolute inset-y-0 left-0 w-1"
      />
      <div className="min-w-0">
        <Link
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId, buildId: build.id }}
          className="block truncate text-[15px] font-semibold text-slate-900 after:absolute after:inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-600"
        >
          {build.branch}
        </Link>
        <p className="mt-px flex gap-2 text-[12.5px] text-slate-400">
          <span className="font-mono">{build.commitSha.slice(0, 7)}</span>
          {build.prNumber !== null && <span>PR #{build.prNumber}</span>}
        </p>
      </div>
      <div>
        <StatusBadge status={build.status} />
      </div>
      <MixBar counts={build.counts} />
      <ToReview build={build} defaultBranch={defaultBranch} />
      <span
        data-testid="rel-time"
        className="text-sm text-slate-400"
        title={build.createdAt.toISOString()}
      >
        {formatRelative(build.createdAt, now)}
      </span>
    </li>
  );
}

/** A project with no builds: where the token comes from and the exact command that uploads. */
function EmptyProject({
  projectId,
  serverUrl,
  hydrated,
}: {
  projectId: string;
  serverUrl: string;
  hydrated: boolean;
}) {
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <div
      data-testid="empty-project"
      className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
    >
      <h2 className="mb-1.5 text-[17px] font-semibold">No builds yet</h2>
      <p className="mx-auto mb-4 max-w-[460px] text-slate-600">
        A build is one upload of snapshots from CI or your machine. Builds on{" "}
        <span className="font-mono text-[13px]">main</span> are accepted as they land; a branch's
        builds are compared against them.
      </p>
      <ol className="mx-auto mt-5 grid max-w-140 gap-2.5 text-left text-slate-600">
        <li className="grid grid-cols-[26px_1fr] items-start gap-2.5">
          <Step n={1} />
          <span>
            Issue a CI token in{" "}
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              className="font-medium text-violet-600 hover:underline"
            >
              Settings
            </Link>
            .
          </span>
        </li>
        <li className="grid grid-cols-[26px_1fr] items-start gap-2.5">
          <Step n={2} />
          <div className="min-w-0">
            Upload a snapshot dir with it:
            <CopyLine
              text={command}
              hydrated={hydrated}
              testId="upload-command"
              className="mt-1.5"
            />
          </div>
        </li>
      </ol>
    </div>
  );
}
