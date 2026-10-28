import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Breadcrumbs,
  Button,
  Caption,
  Card,
  Cluster,
  Code,
  CopyLine,
  EmptyState,
  ListLayout,
  Step,
  Steps,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextLink,
  Text,
} from "@hackcove/ui";
import { MixBar, ToReview, stripeToneOf } from "#/components/build-mix";
import { orgCrumb } from "#/components/crumbs";
import { ProjectFlags } from "#/components/detection-flag";
import { Page, StatusBadge, useHydrated } from "#/components/ui";
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
            <Button
              variant="outline"
              render={(props) => (
                <Link
                  to="/projects/$projectId/flakes"
                  params={{ projectId: project.id }}
                  {...props}
                />
              )}
            >
              Flakes
            </Button>
            <Button
              variant="outline"
              render={(props) => (
                <Link
                  to="/projects/$projectId/settings"
                  params={{ projectId: project.id }}
                  {...props}
                />
              )}
            >
              Settings
            </Button>
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
    <TableRow data-testid="build-row" stripe={stripeToneOf(build)}>
      <TableCell
        secondary={
          <Cluster gap="xs" wrap>
            <Caption mono>{build.commitSha.slice(0, 7)}</Caption>
            {build.prNumber !== null && <Caption>PR #{build.prNumber}</Caption>}
            {build.branch !== defaultBranch && (
              <TextLink
                size="sm"
                tone="muted"
                data-testid="branch-link"
                render={(props) => (
                  <Link
                    to="/projects/$projectId/branches/$branch"
                    params={{ projectId, branch: build.branch }}
                    {...props}
                  />
                )}
              >
                whole branch
              </TextLink>
            )}
          </Cluster>
        }
      >
        <TextLink
          stretch
          render={(props) => (
            <Link
              to="/projects/$projectId/builds/$buildId"
              params={{ projectId, buildId: build.id }}
              {...props}
            />
          )}
        >
          {build.branch}
        </TextLink>
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
  const hydrated = useHydrated();
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <Card as="div" dashed="filled" data-testid="empty-project">
      <EmptyState title="No builds yet">
        <Text as="p" tone="muted">
          A build is one upload of snapshots from CI or your machine. Builds on <Code>main</Code>{" "}
          are accepted as they land; a branch's builds are compared against them.
        </Text>
        <Steps>
          <Step
            title={
              <>
                Issue a CI token in{" "}
                <TextLink
                  render={(props) => (
                    <Link to="/projects/$projectId/settings" params={{ projectId }} {...props} />
                  )}
                >
                  Settings
                </TextLink>
                .
              </>
            }
          />
          <Step title="Upload a snapshot dir with it:">
            <CopyLine text={command} disabled={!hydrated} data-testid="upload-command" />
          </Step>
        </Steps>
      </EmptyState>
    </Card>
  );
}
