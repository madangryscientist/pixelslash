import { Link, createFileRoute } from "@tanstack/react-router";
import { Body } from "@hackcove/ui";
import { orgCrumb } from "#/components/crumbs";
import { Page, StatusBadge } from "#/components/ui";
import type { BuildCounts } from "#/db/review";
import { formatDateTime } from "#/lib/format";
import { getProjectPage } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: ({ params }) => getProjectPage({ data: { projectId: params.projectId } }),
  component: ProjectPage,
});

/** Only what a reviewer counts, and only when there is something to count. */
function countsText(counts: BuildCounts): string {
  const parts = [
    counts.changed && `${counts.changed} changed`,
    counts.new && `${counts.new} new`,
    counts.removed && `${counts.removed} removed`,
    counts.unchanged && `${counts.unchanged} unchanged`,
    counts.rebaseline && `${counts.rebaseline} re-baseline`,
    counts.unmeasured && `${counts.unmeasured} not measured`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no snapshots";
}

function ProjectPage() {
  const { project, org, builds } = Route.useLoaderData();
  return (
    <Page title={project.name} crumbs={[orgCrumb(org), project.name]} wide>
      <div className="mb-6 flex items-center justify-between">
        <Body as="p">
          Builds newest first. {builds.length === 0 ? "" : `${builds.length} in this project.`}
        </Body>
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId: project.id }}
          className="text-sm text-violet-600 hover:underline"
        >
          Settings
        </Link>
      </div>
      {builds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-600">
          <p className="font-medium">No builds yet.</p>
          <p className="mt-1 text-sm">
            Upload one with <code className="font-mono text-slate-900">pixelslash upload DIR</code>{" "}
            and a CI token.
          </p>
        </div>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-2">Branch</th>
              <th>Commit</th>
              <th>PR</th>
              <th>Status</th>
              <th>Snapshots</th>
              <th>Review</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {builds.map((build) => (
              <tr key={build.id} data-testid="build-row">
                <td className="py-2">
                  <Link
                    to="/projects/$projectId/builds/$buildId"
                    params={{ projectId: project.id, buildId: build.id }}
                    className="font-medium text-violet-600 hover:underline"
                  >
                    {build.branch}
                  </Link>
                </td>
                <td className="font-mono text-xs text-slate-600">{build.commitSha.slice(0, 7)}</td>
                <td>{build.prNumber === null ? "—" : `#${build.prNumber}`}</td>
                <td>
                  <StatusBadge status={build.status} />
                </td>
                <td className="text-slate-600">{countsText(build.counts)}</td>
                <td className="text-slate-600">
                  {build.counts.pending === 0 ? "all decided" : `${build.counts.pending} pending`}
                </td>
                <td className="text-slate-500">{formatDateTime(build.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
