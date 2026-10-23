import { Link } from "@tanstack/react-router";
import type { ProjectTimings } from "#/db/timings-stats";
import { formatDuration } from "#/lib/format";
import { STEPS, type Step } from "#/lib/timings";
import { plural } from "./org-projects";

/**
 * The org's Timings tab (ob 1792): for each project, the median and the 95th percentile of every
 * server step over the builds that finished in the last 30 days.
 */

const HEAD = "text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

const LABELS: Record<Step, string> = {
  queue: "Before diff",
  diff: "Diff",
  explain: "AI explanations",
  summary: "AI summary",
  total: "Total",
};

const GRID = "grid-cols-[1.4fr_70px_repeat(5,1fr)]";

function Cell({ step, stats }: { step: Step; stats: ProjectTimings["steps"][Step] }) {
  if (!stats)
    return (
      <span data-testid={`timings-${step}`} className="text-slate-400">
        —
      </span>
    );
  return (
    <span
      data-testid={`timings-${step}`}
      title={plural(stats.n, "build")}
      className="font-mono text-[13px] whitespace-nowrap text-slate-800"
    >
      {formatDuration(stats.p50)} <span className="text-slate-400">/</span>{" "}
      {formatDuration(stats.p95)}
    </span>
  );
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
      {STEPS.map((step) => (
        <Cell key={step} step={step} stats={project.steps[step]} />
      ))}
    </li>
  );
}

export function TimingsPanel({ projects }: { projects: ProjectTimings[] }) {
  if (projects.length === 0)
    return <p className="text-slate-600">No timings for this organization.</p>;
  return (
    <section aria-label="Timings">
      <p className="mb-3 text-sm text-slate-600">
        Median / 95th percentile of each server step, over builds that finished in the last 30 days.
        A step a build did not run is left out, and so is a build that took more than one run.
        Before diff is the time from opening the build to the diff starting, uploads included.
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="min-w-[760px]">
          <div
            aria-hidden="true"
            className={`grid items-center gap-x-4 bg-slate-50 py-2.5 pr-4 pl-5 ${GRID} ${HEAD}`}
          >
            <span>Project</span>
            <span>Builds</span>
            {STEPS.map((step) => (
              <span key={step}>{LABELS[step]}</span>
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
