import { Link } from "@tanstack/react-router";
import {
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@hackcove/ui";
import type { ProjectTimings } from "#/db/timings-stats";
import { formatDuration } from "#/lib/format";
import { P95_MIN_BUILDS, STEPS, STEP_LABELS, TOTAL_EXPLAINED, type Step } from "#/lib/timings";
import { plural } from "./org-projects";

/**
 * The org's Timings tab (ob 1792): for each project, the median and the 95th percentile of every
 * server step over the builds that finished in the last 30 days.
 */

/** The figures of one step: the median, then the tail (the 95th percentile, or the slowest under 20 builds). */
function Cell({
  step,
  stats,
  builds,
}: {
  step: Step;
  stats: ProjectTimings["steps"][Step];
  builds: number;
}) {
  if (!stats)
    return (
      <TableCell tone="muted" data-testid={`timings-${step}`}>
        —
      </TableCell>
    );
  return (
    <TableCell
      mono
      secondary={
        stats.n !== builds && (
          <span data-testid={`timings-${step}-count`}>{plural(stats.n, "build")}</span>
        )
      }
    >
      <span data-testid={`timings-${step}`}>
        {formatDuration(stats.p50)} <Text tone="muted">/</Text>{" "}
        {formatDuration(stats.tail === "max" ? stats.max : stats.p95)}
        {stats.tail === "max" && (
          <>
            {" "}
            <Text tone="muted" data-testid={`timings-${step}-tail`}>
              max
            </Text>
          </>
        )}
      </span>
    </TableCell>
  );
}

export const NO_BUILDS = "No finished builds in the last 30 days";

/** Why a project has no timings: nothing finished, or what finished took more than one run. */
export function emptyReason(project: Pick<ProjectTimings, "rerunBuilds">): string {
  return project.rerunBuilds === 0
    ? NO_BUILDS
    : `${plural(project.rerunBuilds, "build")} finished in the last 30 days, each over more than one run, so none is timed here`;
}

function Row({ project }: { project: ProjectTimings }) {
  return (
    <TableRow data-testid="timings-row">
      <TableCell>
        <TextLink
          stretch
          render={(props) => (
            <Link to="/projects/$projectId" params={{ projectId: project.projectId }} {...props} />
          )}
        >
          {project.name}
        </TextLink>
      </TableCell>
      <TableCell tone="muted" data-testid="timings-builds">
        {project.builds}
      </TableCell>
      {project.builds === 0 ? (
        <TableCell tone="muted" colSpan={STEPS.length} data-testid="timings-empty">
          {emptyReason(project)}
        </TableCell>
      ) : (
        STEPS.map((step) => (
          <Cell key={step} step={step} stats={project.steps[step]} builds={project.builds} />
        ))
      )}
    </TableRow>
  );
}

export function TimingsPanel({ projects }: { projects: ProjectTimings[] }) {
  if (projects.length === 0)
    return (
      <Text as="p" tone="muted">
        No timings for this organization.
      </Text>
    );
  const explained = (
    <Text as="p" tone="muted">
      Median / 95th percentile of each server step, over builds that finished in the last 30 days.
      With under {P95_MIN_BUILDS} builds the second figure is the slowest, and says max. A step a
      build did not run is left out, and so is a build that took more than one run. A step's own
      build count shows when it differs from Builds. Before diff is the time from opening the build
      to the diff starting, uploads included. {TOTAL_EXPLAINED} A build without a start and an end
      in order has no Total.
    </Text>
  );
  if (projects.every((project) => project.builds === 0))
    return (
      <Stack as="section" gap="sm" aria-label="Timings">
        {explained}
        <Stack as="ul" gap="xs">
          {projects.map((project) => (
            <Text as="li" key={project.projectId} tone="muted" data-testid="timings-empty">
              {projects.length > 1 && <Text strong>{project.name}: </Text>}
              {emptyReason(project)}
            </Text>
          ))}
        </Stack>
      </Stack>
    );
  return (
    <Stack as="section" gap="sm" aria-label="Timings">
      {explained}
      <Table caption="Timings per project">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Project</TableHeaderCell>
            <TableHeaderCell>Builds</TableHeaderCell>
            {STEPS.map((step) => (
              <TableHeaderCell key={step}>{STEP_LABELS[step]}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {projects.map((project) => (
            <Row key={project.projectId} project={project} />
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}
