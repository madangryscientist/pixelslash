import { Link } from "@tanstack/react-router";
import type { ProjectTimings } from "#/db/timings-stats";
import { formatDuration } from "#/lib/format";
import { P95_MIN_BUILDS, STEPS, STEP_LABELS, TOTAL_EXPLAINED, type Step } from "#/lib/timings";
import { plural } from "./org-projects";

/**
 * The org's Timings tab (ob 1792): for each project, the median and the 95th percentile of every
 * server step over the builds that finished in the last 30 days.
 */

const HEAD = "text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

const GRID = "grid-cols-[1.4fr_70px_repeat(5,1fr)]";

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
      <span data-testid={`timings-${step}`} className="text-slate-400">
        —
      </span>
    );
  return (
    <span data-testid={`timings-${step}`} className="flex flex-col">
      <span className="font-mono text-[13px] whitespace-nowrap text-slate-800 tabular-nums">
        {formatDuration(stats.p50)} <span className="text-slate-400">/</span>{" "}
        {formatDuration(stats.tail === "max" ? stats.max : stats.p95)}
        {stats.tail === "max" && (
          <span data-testid={`timings-${step}-tail`} className="ml-1 text-[11px] text-slate-500">
            max
          </span>
        )}
      </span>
      {stats.n !== builds && (
        <span data-testid={`timings-${step}-count`} className="text-[11px] text-slate-500">
          {plural(stats.n, "build")}
        </span>
      )}
    </span>
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
    <li
      data-testid="timings-row"
      className={`grid items-center gap-x-4 border-t border-slate-100 py-3 pr-4 pl-5 first:border-t-0 ${GRID}`}
    >
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.projectId }}
        className="truncate text-[15px] font-semibold text-slate-900 hover:underline"
      >
        {project.name}
      </Link>
      <span data-testid="timings-builds" className="text-sm text-slate-600">
        {project.builds}
      </span>
      {project.builds === 0 ? (
        <span data-testid="timings-empty" className="col-span-5 text-sm text-slate-500">
          {emptyReason(project)}
        </span>
      ) : (
        STEPS.map((step) => (
          <Cell key={step} step={step} stats={project.steps[step]} builds={project.builds} />
        ))
      )}
    </li>
  );
}

export function TimingsPanel({ projects }: { projects: ProjectTimings[] }) {
  if (projects.length === 0)
    return <p className="text-slate-600">No timings for this organization.</p>;
  const explained = (
    <p className="mb-3 text-sm text-slate-600">
      Median / 95th percentile of each server step, over builds that finished in the last 30 days.
      With under {P95_MIN_BUILDS} builds the second figure is the slowest, and says max. A step a
      build did not run is left out, and so is a build that took more than one run. A step's own
      build count shows when it differs from Builds. Before diff is the time from opening the build
      to the diff starting, uploads included. {TOTAL_EXPLAINED} A build without a start and an end
      in order has no Total.
    </p>
  );
  if (projects.every((project) => project.builds === 0))
    return (
      <section aria-label="Timings">
        {explained}
        <ul>
          {projects.map((project) => (
            <li key={project.projectId} data-testid="timings-empty" className="text-slate-600">
              {projects.length > 1 && <span className="font-semibold">{project.name}: </span>}
              {emptyReason(project)}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <section aria-label="Timings">
      {explained}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="min-w-[760px]">
          <div
            aria-hidden="true"
            className={`grid items-center gap-x-4 bg-slate-50 py-2.5 pr-4 pl-5 ${GRID} ${HEAD}`}
          >
            <span>Project</span>
            <span>Builds</span>
            {STEPS.map((step) => (
              <span key={step}>{STEP_LABELS[step]}</span>
            ))}
          </div>
          <ul>
            {projects.map((project) => (
              <Row key={project.projectId} project={project} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
