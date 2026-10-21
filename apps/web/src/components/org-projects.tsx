import { Link } from "@tanstack/react-router";
import { MixBar, ToReview, stripeOf } from "#/components/build-mix";
import { StatusBadge } from "#/components/ui";
import type { LatestBuild, OrgOverview, ProjectOverview } from "#/db/orgs";
import { formatNumber, formatRelative } from "#/lib/format";

/** The words for a number: `1 invite`, `2 invites`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

const HEAD = "text-[11px] font-semibold tracking-wider text-slate-400 uppercase";

/** Which build is latest (verdict, branch, commit, PR), or how to get a first one. */
function BuildCell({ project }: { project: ProjectOverview }) {
  const { latest } = project;
  if (!latest) {
    return (
      <div className="flex flex-col gap-0.75">
        <span className="text-sm text-slate-400">no builds</span>
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId: project.id }}
          className="relative z-10 w-fit text-xs text-violet-600 hover:underline"
        >
          Set up uploads →
        </Link>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.75">
      <div className="flex items-center gap-2 whitespace-nowrap">
        <StatusBadge status={latest.status} />
        <span className="min-w-0 truncate text-sm">{latest.branch}</span>
        <span className="font-mono text-[12.5px] text-slate-400">
          {latest.commitSha.slice(0, 7)}
        </span>
      </div>
      {latest.prNumber !== null && (
        <span className="text-xs text-slate-400">PR #{latest.prNumber}</span>
      )}
    </div>
  );
}

/** When the latest build landed, or when the project was made if it has none. */
function Updated({ project, now }: { project: ProjectOverview; now: Date }) {
  const { latest } = project;
  return (
    <span
      data-testid="rel-time"
      className="text-sm text-slate-400"
      title={(latest?.createdAt ?? project.createdAt).toISOString()}
    >
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
    <li
      data-testid="project-row"
      className="relative grid items-center gap-x-4 gap-y-2 border-t border-slate-100 py-3.5 pr-4 pl-5 first:border-t-0 hover:bg-slate-50 lg:grid-cols-[1.3fr_1.6fr_1.3fr_110px_92px_34px]"
    >
      <span
        aria-hidden="true"
        style={latest ? { background: stripeOf(latest) } : undefined}
        className={`absolute inset-y-0 left-0 w-1 ${latest ? "" : "bg-slate-200"}`}
      />
      <div className="min-w-0">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="block truncate text-[15px] font-semibold text-slate-900 after:absolute after:inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-600"
        >
          {project.name}
        </Link>
        <p className="mt-px text-[12.5px] text-slate-400">
          {latest ? plural(shots, "shot") : "no builds yet"}
        </p>
      </div>
      <BuildCell project={project} />
      {latest ? <MixBar counts={latest.counts} /> : <span className="text-slate-400">—</span>}
      <ToReview build={latest} />
      <Updated project={project} now={now} />
      <Link
        to="/projects/$projectId/settings"
        params={{ projectId: project.id }}
        aria-label={`${project.name} settings`}
        title="Settings"
        className="relative z-10 grid h-8 w-8 place-items-center justify-self-end rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-violet-600"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-4 w-4 fill-none stroke-current stroke-2"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </Link>
    </li>
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
    <div
      data-testid="waiting-strip"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-(--ps-changed)/35 bg-(--ps-warn-soft) px-4 py-3"
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-(--ps-changed)" />
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {waiting.map((project, index) => (
          <li key={project.id} className="flex items-center gap-2">
            {index > 0 && <span className="text-slate-400">·</span>}
            <Link
              to="/projects/$projectId/builds/$buildId"
              params={{ projectId: project.id, buildId: project.latest.id }}
              className="font-semibold text-slate-900 hover:underline"
            >
              {project.name} · {project.latest.branch}
            </Link>
            <span className="text-slate-600">{project.latest.counts.toReview} to review</span>
          </li>
        ))}
      </ul>
      <Link
        to="/projects/$projectId/builds/$buildId"
        params={{ projectId: next.id, buildId: next.latest.id }}
        className="inline-flex h-8.5 items-center rounded-lg border border-slate-300 bg-white px-3.5 text-[13px] font-semibold text-slate-900 hover:bg-slate-50"
      >
        Review next
      </Link>
    </div>
  );
}

export function ProjectTable({ org, now }: { org: OrgOverview; now: Date }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div
        aria-hidden="true"
        className={`hidden items-center gap-4 bg-slate-50 py-2.5 pr-4 pl-5 lg:grid lg:grid-cols-[1.3fr_1.6fr_1.3fr_110px_92px_34px] ${HEAD}`}
      >
        <span>Project</span>
        <span>Latest build</span>
        <span>Snapshots</span>
        <span>To review</span>
        <span>Updated</span>
        <span />
      </div>
      <ul>
        {org.projects.map((project) => (
          <ProjectRow key={project.id} project={project} now={now} />
        ))}
      </ul>
    </div>
  );
}
