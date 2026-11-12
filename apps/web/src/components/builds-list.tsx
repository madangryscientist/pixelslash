import { Link } from "@tanstack/react-router";
import {
  Caption,
  Card,
  Cluster,
  ListRow,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@hackcove/ui-react";
import { MixBar, ToReview, stripeToneOf } from "#/components/build-mix";
import { StatusBadge } from "#/components/ui";
import type { BuildSummary } from "#/db/build-list";
import { formatRelative } from "#/lib/format";

/** The builds: a stacked card each on a phone, the table from the kit's `sm` up. */
export function BuildsList({
  projectId,
  defaultBranch,
  builds,
  now,
}: {
  projectId: string;
  defaultBranch: string;
  builds: BuildSummary[];
  now: Date;
}) {
  return (
    <>
      {/* A phone gets one stacked row per build; the table, which the kit scrolls sideways, would hide three of its five columns. */}
      <div className="sm:hidden">
        <Card as="div" flush>
          {builds.map((build, index) => (
            <BuildCard
              key={build.id}
              projectId={projectId}
              defaultBranch={defaultBranch}
              build={build}
              now={now}
              divided={index > 0}
            />
          ))}
        </Card>
      </div>
      <div className="hidden sm:block">
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
                projectId={projectId}
                defaultBranch={defaultBranch}
                build={build}
                now={now}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * The status a build's row shows. A build stored as `passed` that still has shots to review would
 * read "passed" beside "21 to review", so the list shows it as `changes`, the badge a build with
 * work waiting gets. Builds written under an older verdict rule carry that stale status (the
 * stored value is fixed apart from this view); `verdictOf` and the API are untouched.
 */
function listStatus(build: BuildSummary): string {
  return build.status === "passed" && build.counts.toReview > 0 ? "changes" : build.status;
}

/** The line under a build's branch: its short sha, its PR and a link to the whole branch. */
function BuildMeta({
  projectId,
  defaultBranch,
  build,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
}) {
  return (
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
  );
}

/** One build as a stacked block for a phone: branch and status, the mix bar, then review and when. */
function BuildCard({
  projectId,
  defaultBranch,
  build,
  now,
  divided,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
  now: Date;
  divided: boolean;
}) {
  return (
    <ListRow
      divided={divided}
      render={(props) => (
        <Link
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId, buildId: build.id }}
          {...props}
        />
      )}
    >
      <Stack gap="xs" data-testid="build-card">
        <Cluster justify="between" gap="sm">
          <Text strong>{build.branch}</Text>
          <StatusBadge status={listStatus(build)} />
        </Cluster>
        <BuildMeta projectId={projectId} defaultBranch={defaultBranch} build={build} />
        <MixBar counts={build.counts} />
        <Cluster justify="between" gap="sm" wrap>
          <div>
            <ToReview build={build} defaultBranch={defaultBranch} />
          </div>
          <Text tone="muted">
            <span data-testid="rel-time" title={build.createdAt.toISOString()}>
              {formatRelative(build.createdAt, now)}
            </span>
          </Text>
        </Cluster>
      </Stack>
    </ListRow>
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
        secondary={<BuildMeta projectId={projectId} defaultBranch={defaultBranch} build={build} />}
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
        <StatusBadge status={listStatus(build)} />
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
