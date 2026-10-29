import { and, eq, isNull } from "drizzle-orm";
import { buildUrl } from "#/api/read";
import type { Db } from "#/db/db";
import { type OpenShot, openShotsOf } from "#/db/open-shots";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/review";
import { type BuildStatus, builds, projects } from "#/db/schema";
import { warn } from "#/lib/log";
import { reportError } from "#/server/sentry";
import { type GithubApp, type RepoName, field, isRepoName } from "./app";

/*
 * The "PixelSlash" check run on a build's commit (PS-23): one per build, created the first time
 * the build is synced and updated in place after that. It carries counts and a link to the build
 * page, never an image (invariant 4). GitHub is told, never asked: a failed call is logged and
 * reported, and the build's verdict and the request that synced it are untouched.
 *
 * A server without the App but with a token (PS-235) posts the same states as a commit status,
 * context "PixelSlash". The App wins when both are configured; with neither, nothing is called.
 */

const CHECK_RUN_NAME = "PixelSlash";

export type CheckRunDeps = {
  db: Db;
  /** The deployment's App; null when it is not configured, and then nothing calls GitHub. */
  app: GithubApp | null;
  /** The deployment's token for commit statuses (PS-235); used only when `app` is null. */
  token: GithubApp | null;
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

/** How many shots the summary names; the build page has the rest. */
const NAMED_SHOTS = 10;

/** The shots awaiting review, counted and named: a carried change is `unchanged` in the table. */
function openLines(open: OpenShot[]): string[] {
  if (open.length === 0) return [];
  const changed = open.filter((shot) => shot.kind === "changed").length;
  const added = open.length - changed;
  const named = open
    .slice(0, NAMED_SHOTS)
    .map(
      (shot) =>
        `- ${shot.kind === "new" ? "New" : "Changed"}: ${shot.name} (${shot.viewport}, ${shot.theme})`,
    );
  const more = open.length - named.length;
  return [
    "",
    `Waiting for review: ${plural(changed, "changed shot")} and ${plural(added, "new shot")}.`,
    ...named,
    ...(more > 0 ? [`- and ${more} more`] : []),
  ];
}

function summaryOf(
  build: SyncedBuild,
  counts: BuildCounts,
  open: OpenShot[],
  detailsUrl: string | undefined,
) {
  const lines =
    build.status === "uploading" || build.status === "processing"
      ? ["The build is being diffed."]
      : [
          `| Changed | To review | Accepted | Rejected | New | Removed | Unchanged |`,
          `| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
          `| ${counts.changed} | ${counts.toReview} | ${counts.accepted} | ${counts.rejected} | ${counts.new} | ${counts.removed} | ${counts.unchanged} |`,
          ...openLines(open),
          "",
          "Removed shots do not fail the check.",
        ];
  if (detailsUrl) lines.push("", `[Review the build](${detailsUrl})`);
  return lines.join("\n");
}

/**
 * What the check run says for a build: `in_progress` while it is diffed; `failure` while a change
 * awaits review, a shot is rejected, or the build errored (the title names the error); `success`
 * when every change is accepted or nothing changed. New shots wait for review like changes do
 * (PS-284).
 */
function checkRunOf(
  build: SyncedBuild,
  counts: BuildCounts,
  open: OpenShot[],
  detailsUrl: string | undefined,
): CheckRunBody {
  const done = build.status !== "uploading" && build.status !== "processing";
  return {
    name: CHECK_RUN_NAME,
    external_id: build.id,
    ...(detailsUrl && { details_url: detailsUrl }),
    status: done ? "completed" : "in_progress",
    ...(done && { conclusion: build.status === "passed" ? "success" : "failure" }),
    output: { title: titleOf(build, counts), summary: summaryOf(build, counts, open, detailsUrl) },
  };
}

const detailsUrlOf = (publicUrl: string | undefined, build: SyncedBuild) =>
  publicUrl
    ? buildUrl({ origin: publicUrl.replace(/\/+$/, "") }, build.projectId, build.id)
    : undefined;

/** A status description is at most 140 characters. */
const STATUS_DESCRIPTION_MAX = 140;

export type StatusBody = {
  state: "pending" | "success" | "failure";
  context: string;
  description: string;
  target_url?: string;
};

/** The check run's state as a commit status: `in_progress` is `pending`, the conclusions are kept. */
function statusOf(run: CheckRunBody): StatusBody {
  return {
    state: run.status === "in_progress" ? "pending" : (run.conclusion ?? "failure"),
    context: run.name,
    description: run.output.title.slice(0, STATUS_DESCRIPTION_MAX),
    ...(run.details_url && { target_url: run.details_url }),
  };
}

type BuildRow = SyncedBuild & { commitSha: string; checkRunId: number | null; repo: RepoName };

async function loadBuild(db: Db, buildId: string): Promise<BuildRow | null> {
  const [row] = await db
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
  if (!row?.repo || !isRepoName(row.repo)) return null;
  return { ...row, repo: row.repo };
}

async function bodyOf(deps: CheckRunDeps, row: BuildRow): Promise<CheckRunBody> {
  const counts = (await countBuilds(deps.db, [row.id])).get(row.id) ?? emptyCounts();
  const open = row.status === "changes" ? await openShotsOf(deps.db, row.id) : [];
  return checkRunOf(row, counts, open, detailsUrlOf(deps.publicUrl, row));
}

/** A commit status is a new entry on the commit, newest wins: there is no id to keep. */
async function syncStatus(deps: CheckRunDeps, client: GithubApp, row: BuildRow): Promise<void> {
  const status = statusOf(await bodyOf(deps, row));
  await client.request(row.repo, "POST", `/repos/${row.repo}/statuses/${row.commitSha}`, status);
}

async function syncCheckRun(deps: CheckRunDeps, app: GithubApp, row: BuildRow): Promise<void> {
  const { repo } = row;
  const body = await bodyOf(deps, row);
  const update = (id: number) =>
    app.request(repo, "PATCH", `/repos/${repo}/check-runs/${id}`, body);
  if (row.checkRunId !== null) {
    await update(row.checkRunId);
    return;
  }
  const created = await app.request(repo, "POST", `/repos/${repo}/check-runs`, {
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
 * Bring each build's check run (or, with only the token, its commit status) up to its current
 * state. Does nothing when neither is configured or the build's project has no repo, and never
 * throws.
 */
export async function syncCheckRuns(deps: CheckRunDeps, buildIds: Iterable<string>): Promise<void> {
  const { app, token } = deps;
  if (!app && !token) return;
  for (const buildId of new Set(buildIds)) {
    try {
      const row = await loadBuild(deps.db, buildId);
      if (!row) continue;
      if (app) await syncCheckRun(deps, app, row);
      else if (token) await syncStatus(deps, token, row);
    } catch (error) {
      warn(
        `github check run for build ${buildId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportError(error, { area: "github" });
    }
  }
}
