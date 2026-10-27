import { and, eq, isNull } from "drizzle-orm";
import { buildUrl } from "#/api/read";
import type { Db } from "#/db/db";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/review";
import { type BuildStatus, builds, projects } from "#/db/schema";
import { warn } from "#/lib/log";
import { reportError } from "#/server/sentry";
import { type GithubApp, field, isRepoName } from "./app";

/*
 * The "PixelSlash" check run on a build's commit (PS-23): one per build, created the first time
 * the build is synced and updated in place after that. It carries counts and a link to the build
 * page, never an image (invariant 4). GitHub is told, never asked: a failed call is logged and
 * reported, and the build's verdict and the request that synced it are untouched.
 */

const CHECK_RUN_NAME = "PixelSlash";

export type CheckRunDeps = {
  db: Db;
  /** The deployment's App; null when it is not configured, and then nothing calls GitHub. */
  app: GithubApp | null;
  /** The server's public URL (`PIXELSLASH_PUBLIC_URL`), for `details_url`; unset sends none. */
  publicUrl: string | undefined;
};

type SyncedBuild = {
  id: string;
  projectId: string;
  status: BuildStatus;
  error: string | null;
};

export type CheckRunBody = {
  name: string;
  head_sha?: string;
  external_id: string;
  details_url?: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure";
  output: { title: string; summary: string };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function titleOf(build: SyncedBuild, counts: BuildCounts): string {
  if (build.status === "errored")
    return `Build errored: ${build.error ?? "no reason recorded"}`.slice(0, 200);
  if (build.status === "failed") return `${plural(counts.rejected, "change")} rejected`;
  if (build.status === "changes") return `${plural(counts.toReview, "change")} to review`;
  if (build.status === "passed")
    return counts.changed > 0 ? "All changes accepted" : "No visual changes";
  return "Diffing the shots";
}

function summaryOf(build: SyncedBuild, counts: BuildCounts, detailsUrl: string | undefined) {
  const lines =
    build.status === "uploading" || build.status === "processing"
      ? ["The build is being diffed."]
      : [
          `| Changed | To review | Accepted | Rejected | New | Removed | Unchanged |`,
          `| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
          `| ${counts.changed} | ${counts.toReview} | ${counts.accepted} | ${counts.rejected} | ${counts.new} | ${counts.removed} | ${counts.unchanged} |`,
          "",
          "New and removed shots do not fail the check.",
        ];
  if (detailsUrl) lines.push("", `[Review the build](${detailsUrl})`);
  return lines.join("\n");
}

/**
 * What the check run says for a build: `in_progress` while it is diffed; `failure` while a change
 * awaits review, a shot is rejected, or the build errored (the title names the error); `success`
 * when every change is accepted or nothing changed.
 */
function checkRunOf(
  build: SyncedBuild,
  counts: BuildCounts,
  detailsUrl: string | undefined,
): CheckRunBody {
  const done = build.status !== "uploading" && build.status !== "processing";
  return {
    name: CHECK_RUN_NAME,
    external_id: build.id,
    ...(detailsUrl && { details_url: detailsUrl }),
    status: done ? "completed" : "in_progress",
    ...(done && { conclusion: build.status === "passed" ? "success" : "failure" }),
    output: { title: titleOf(build, counts), summary: summaryOf(build, counts, detailsUrl) },
  };
}

const detailsUrlOf = (publicUrl: string | undefined, build: SyncedBuild) =>
  publicUrl
    ? buildUrl({ origin: publicUrl.replace(/\/+$/, "") }, build.projectId, build.id)
    : undefined;

async function syncOne(deps: CheckRunDeps & { app: GithubApp }, buildId: string): Promise<void> {
  const [row] = await deps.db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      error: builds.error,
      commitSha: builds.commitSha,
      checkRunId: builds.checkRunId,
      repo: projects.githubRepo,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(eq(builds.id, buildId));
  // A repo stored before it was checked is skipped, not sent to GitHub.
  if (!row?.repo || !isRepoName(row.repo)) return;
  const { repo } = row;
  const counts = (await countBuilds(deps.db, [row.id])).get(row.id) ?? emptyCounts();
  const body = checkRunOf(row, counts, detailsUrlOf(deps.publicUrl, row));
  const update = (id: number) =>
    deps.app.request(repo, "PATCH", `/repos/${repo}/check-runs/${id}`, body);
  if (row.checkRunId !== null) {
    await update(row.checkRunId);
    return;
  }
  const created = await deps.app.request(repo, "POST", `/repos/${repo}/check-runs`, {
    ...body,
    head_sha: row.commitSha,
  });
  const id = Number(field(created, "id"));
  const stored = await deps.db
    .update(builds)
    .set({ checkRunId: id })
    .where(and(eq(builds.id, row.id), isNull(builds.checkRunId)))
    .returning({ id: builds.id });
  if (stored.length > 0) return;
  // Another sync created one first: that one is the build's, so it gets this state too.
  const [winner] = await deps.db
    .select({ checkRunId: builds.checkRunId })
    .from(builds)
    .where(eq(builds.id, row.id));
  if (winner?.checkRunId) await update(winner.checkRunId);
}

/**
 * Bring each build's check run up to its current state. Does nothing when the App is not
 * configured or the build's project has no repo, and never throws.
 */
export async function syncCheckRuns(deps: CheckRunDeps, buildIds: Iterable<string>): Promise<void> {
  const { app } = deps;
  if (!app) return;
  for (const buildId of new Set(buildIds)) {
    try {
      await syncOne({ ...deps, app }, buildId);
    } catch (error) {
      warn(
        `github check run for build ${buildId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportError(error, { area: "github" });
    }
  }
}
