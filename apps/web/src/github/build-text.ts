import { buildUrl } from "#/api/read";
import type { BuildCounts } from "#/db/build-counts";
import type { BuildStatus } from "#/db/schema";

/** The words the check run and the PR comment share (PS-23, PS-82): a build's title, counts and link. */

export type SyncedBuild = {
  id: string;
  projectId: string;
  status: BuildStatus;
  error: string | null;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function titleOf(build: SyncedBuild, counts: BuildCounts): string {
  if (build.status === "errored")
    return `Build errored: ${build.error ?? "no reason recorded"}`.slice(0, 200);
  if (build.status === "failed") return `${plural(counts.rejected, "change")} rejected`;
  if (build.status === "changes") return `${plural(counts.toReview, "change")} to review`;
  if (build.status === "passed")
    return counts.changed > 0 ? "All changes accepted" : "No visual changes";
  return "Diffing the shots";
}

/** The counts as a Markdown table, as the check run's summary and the PR comment show them. */
export const countsTable = (counts: BuildCounts): string[] => [
  `| Changed | To review | Accepted | Rejected | New | Removed | Unchanged |`,
  `| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  `| ${counts.changed} | ${counts.toReview} | ${counts.accepted} | ${counts.rejected} | ${counts.new} | ${counts.removed} | ${counts.unchanged} |`,
];

export const detailsUrlOf = (publicUrl: string | undefined, build: SyncedBuild) =>
  publicUrl
    ? buildUrl({ origin: publicUrl.replace(/\/+$/, "") }, build.projectId, build.id)
    : undefined;
