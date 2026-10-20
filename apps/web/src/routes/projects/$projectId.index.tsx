import { Link, createFileRoute } from "@tanstack/react-router";
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
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no snapshots";
}

function ProjectPage() {
  const { project, builds } = Route.useLoaderData();
  return (
    <Page title={project.name} wide>
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-neutral-600">
          Builds newest first. {builds.length === 0 ? "" : `${builds.length} in this project.`}
        </p>
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId: project.id }}
          className="text-sm text-blue-700 hover:underline"
        >
          Settings
        </Link>
      </div>
      {builds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-600">
          <p className="font-medium">No builds yet.</p>
          <p className="mt-1 text-sm">
            Upload one with <code className="font-mono">pixelslash upload DIR</code> and a CI token.
          </p>
        </div>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-500">
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
          <tbody className="divide-y divide-neutral-100">
            {builds.map((build) => (
              <tr key={build.id} data-testid="build-row">
                <td className="py-2">
                  <Link
                    to="/projects/$projectId/builds/$buildId"
                    params={{ projectId: project.id, buildId: build.id }}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {build.branch}
                  </Link>
                </td>
                <td className="font-mono text-xs">{build.commitSha.slice(0, 7)}</td>
                <td>{build.prNumber === null ? "—" : `#${build.prNumber}`}</td>
                <td>
                  <StatusBadge status={build.status} />
                </td>
                <td className="text-neutral-600">{countsText(build.counts)}</td>
                <td className="text-neutral-600">
                  {build.counts.pending === 0 ? "all decided" : `${build.counts.pending} pending`}
                </td>
                <td className="text-neutral-500">{formatDateTime(build.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
