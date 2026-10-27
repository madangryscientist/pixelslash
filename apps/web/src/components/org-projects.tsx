import { Link } from "@tanstack/react-router";
import {
  Body,
  ButtonLink,
  Callout,
  Caption,
  Cluster,
  ClusterGrow,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextLink,
  rowLinkClass,
} from "@hackcove/ui";
import { MixBar, ToReview, stripeToneOf } from "#/components/build-mix";
import { StatusBadge } from "#/components/ui";
import type { LatestBuild, OrgOverview, ProjectOverview } from "#/db/orgs";
import { formatNumber, formatRelative } from "#/lib/format";

/** The words for a number: `1 invite`, `2 invites`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** Which build is latest (verdict, branch, commit, PR), or how to get a first one. */
function BuildCell({ project }: { project: ProjectOverview }) {
  const { latest } = project;
  if (!latest) {
    return (
      <Stack gap="xs">
        <Body tone="muted">no builds</Body>
        <TextLink
          size="xs"
          render={(props) => (
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              {...props}
            />
          )}
        >
          Set up uploads →
        </TextLink>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Cluster gap="sm">
        <StatusBadge status={latest.status} />
        <ClusterGrow>
          <Body truncate>{latest.branch}</Body>
        </ClusterGrow>
        <Caption mono>{latest.commitSha.slice(0, 7)}</Caption>
      </Cluster>
      {latest.prNumber !== null && <Caption>PR #{latest.prNumber}</Caption>}
    </Stack>
  );
}

/** When the latest build landed, or when the project was made if it has none. */
function Updated({ project, now }: { project: ProjectOverview; now: Date }) {
  const { latest } = project;
  return (
    <span data-testid="rel-time" title={(latest?.createdAt ?? project.createdAt).toISOString()}>
      {latest
        ? formatRelative(latest.createdAt, now)
        : `created ${formatRelative(project.createdAt, now)}`}
    </span>
  );
}

function ProjectRow({ project, now }: { project: ProjectOverview; now: Date }) {
  const { latest } = project;
  const shots = latest ? latest.total - latest.counts.removed : 0;
  return (
    <TableRow data-testid="project-row" stripe={stripeToneOf(latest)}>
      <TableCell secondary={latest ? plural(shots, "shot") : "no builds yet"}>
        <Link to="/projects/$projectId" params={{ projectId: project.id }} className={rowLinkClass}>
          {project.name}
        </Link>
      </TableCell>
      <TableCell>
        <BuildCell project={project} />
      </TableCell>
      <TableCell>
        {latest ? <MixBar counts={latest.counts} /> : <Body tone="muted">—</Body>}
      </TableCell>
      <TableCell>
        <ToReview build={latest} defaultBranch={project.defaultBranch} />
      </TableCell>
      <TableCell tone="muted">
        <Updated project={project} now={now} />
      </TableCell>
      <TableCell align="end">
        <IconButton
          variant="ghost"
          label={`${project.name} settings`}
          render={(props) => (
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              {...props}
            />
          )}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-4 fill-none stroke-current stroke-2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </IconButton>
      </TableCell>
    </TableRow>
  );
}

/** One link per build that is waiting on someone, and the next one to open. */
export function WaitingStrip({ org }: { org: OrgOverview }) {
  const waiting = org.projects.filter(
    (project): project is ProjectOverview & { latest: LatestBuild } =>
      project.latest !== null && project.latest.counts.toReview > 0,
  );
  const [next] = waiting;
  if (!next) return null;
  return (
    <Callout
      data-testid="waiting-strip"
      tone="warn"
      actions={
        <ButtonLink
          variant="outline"
          size="sm"
          render={(props) => (
            <Link
              to="/projects/$projectId/builds/$buildId"
              params={{ projectId: next.id, buildId: next.latest.id }}
              {...props}
            />
          )}
        >
          Review next
        </ButtonLink>
      }
    >
      <Cluster gap="sm" wrap>
        {waiting.map((project, index) => (
          <Cluster key={project.id} gap="sm">
            {index > 0 && <Body tone="muted">·</Body>}
            <TextLink
              render={(props) => (
                <Link
                  to="/projects/$projectId/builds/$buildId"
                  params={{ projectId: project.id, buildId: project.latest.id }}
                  {...props}
                />
              )}
            >
              {project.name} · {project.latest.branch}
            </TextLink>
            <Body tone="muted">{project.latest.counts.toReview} to review</Body>
          </Cluster>
        ))}
      </Cluster>
    </Callout>
  );
}

export function ProjectTable({ org, now }: { org: OrgOverview; now: Date }) {
  return (
    <Table caption="Projects">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Project</TableHeaderCell>
          <TableHeaderCell>Latest build</TableHeaderCell>
          <TableHeaderCell>Snapshots</TableHeaderCell>
          <TableHeaderCell>To review</TableHeaderCell>
          <TableHeaderCell>Updated</TableHeaderCell>
          <TableHeaderCell align="end" srLabel="Settings" />
        </TableRow>
      </TableHead>
      <TableBody>
        {org.projects.map((project) => (
          <ProjectRow key={project.id} project={project} now={now} />
        ))}
      </TableBody>
    </Table>
  );
}
