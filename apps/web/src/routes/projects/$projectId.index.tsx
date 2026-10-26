import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Breadcrumbs,
  buttonClass,
  Card,
  CopyLine,
  ListLayout,
  rowLinkClass,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { MixBar, ToReview, stripeOf } from "#/components/build-mix";
import { orgCrumb } from "#/components/crumbs";
import { ProjectFlags } from "#/components/detection-flag";
import { Step } from "#/components/org-empty";
import { Page, StatusBadge } from "#/components/ui";
import type { BuildSummary } from "#/db/build-list";
import { formatRelative } from "#/lib/format";
import { getProjectPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: ({ params }) => getProjectPage({ data: { projectId: params.projectId } }),
  component: ProjectPage,
});

function ProjectPage() {
  const { project, org, builds, flags, now, serverUrl } = Route.useLoaderData();
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs crumbs={[orgCrumb(org), project.name]} />}
        title={project.name}
        subtitle={
          builds.length === 0
            ? "No builds yet."
            : `Builds newest first. ${builds.length} in this project.`
        }
        actions={
          <>
            <Link
              to="/projects/$projectId/flakes"
              params={{ projectId: project.id }}
              className={buttonClass("outline")}
            >
              Flakes
            </Link>
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              className={buttonClass("outline")}
            >
              Settings
            </Link>
          </>
        }
      >
        {builds.length === 0 ? (
          <EmptyProject projectId={project.id} serverUrl={serverUrl} />
        ) : (
          <Table caption="Builds">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Branch</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Snapshots</TableHeaderCell>
                <TableHeaderCell>Review</TableHeaderCell>
                <TableHeaderCell>When</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {builds.map((build) => (
                <BuildRow
                  key={build.id}
                  projectId={project.id}
                  defaultBranch={project.defaultBranch}
                  build={build}
                  now={now}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <ProjectFlags projectId={project.id} flags={flags} />
      </ListLayout>
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
    <TableRow data-testid="build-row">
      <TableCell
        secondary={
          <span className="flex gap-2">
            <span className="font-mono">{build.commitSha.slice(0, 7)}</span>
            {build.prNumber !== null && <span>PR #{build.prNumber}</span>}
            {build.branch !== defaultBranch && (
              // Above the row's covering link, so it is a link of its own.
              <Link
                to="/projects/$projectId/branches/$branch"
                params={{ projectId, branch: build.branch }}
                className="relative z-10 hover:text-slate-700 hover:underline"
                data-testid="branch-link"
              >
                whole branch
              </Link>
            )}
          </span>
        }
      >
        <span
          aria-hidden="true"
          style={{ background: stripeOf(build) }}
          className="absolute inset-y-0 left-0 w-1"
        />
        <Link
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId, buildId: build.id }}
          className={rowLinkClass}
        >
          {build.branch}
        </Link>
      </TableCell>
      <TableCell>
        <StatusBadge status={build.status} />
      </TableCell>
      <TableCell>
        <MixBar counts={build.counts} />
      </TableCell>
      <TableCell>
        <ToReview build={build} defaultBranch={defaultBranch} />
      </TableCell>
      <TableCell tone="muted">
        <span data-testid="rel-time" title={build.createdAt.toISOString()}>
          {formatRelative(build.createdAt, now)}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** A project with no builds: where the token comes from and the exact command that uploads. */
function EmptyProject({ projectId, serverUrl }: { projectId: string; serverUrl: string }) {
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <Card as="div" dashed="filled" data-testid="empty-project">
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
          <Stack gap="xs">
            <span>Upload a snapshot dir with it:</span>
            <CopyLine text={command} data-testid="upload-command" />
          </Stack>
        </li>
      </ol>
    </Card>
  );
}
