import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/db";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/build-counts";
import { builds, projects } from "#/db/schema";
import { warn } from "#/lib/log";
import { reportError } from "#/server/sentry";
import { GithubError, type GithubApp, type RepoName, isRepoName } from "./app";
import { type SyncedBuild, detailsUrlOf, titleOf } from "./build-text";
import { syncPrComment } from "./pr-comment";

/*
 * The "PixelSlash" commit status on a build's commit (PS-23, PS-235): a new status each time the
 * build is synced, newest wins. Its Details link opens the build page in one click, which a check
 * run's cannot (GitHub sends that to its own check page). It carries the title and a link, never
 * an image (invariant 4). GitHub is told, never asked: a failed call is logged and reported, and
 * the build's verdict and the request that synced it are untouched.
 *
 * The App posts it with its installation token when configured, else the server's token; with
 * neither, nothing is called. A build synced before the App moved to statuses may still hold a
 * check run: the App completes it once as `neutral` and forgets its id.
 *
 * When several of an org's projects are linked to one repo, each build's status is named
 * "PixelSlash / <project name>", so a reviewer can tell them apart; one project keeps the plain name.
 */

const CHECK_RUN_NAME = "PixelSlash";

/** The check's name: plain for a repo's only project, with the project's name when it shares one. */
function checkNameOf(projectName: string, projectsOnRepo: number): string {
  return projectsOnRepo > 1 ? `${CHECK_RUN_NAME} / ${projectName}` : CHECK_RUN_NAME;
}

export type CheckRunDeps = {
  db: Db;
  /** The deployment's App; null when it is not configured, and then nothing calls GitHub. */
  app: GithubApp | null;
  /** The deployment's token for commit statuses (PS-235); used only when `app` is null. */
  token: GithubApp | null;
  /** The server's public URL (`PIXELSLASH_PUBLIC_URL`), for `details_url`; unset sends none. */
  publicUrl: string | undefined;
};

/** What the build's state is on GitHub, before it is put as a commit status. */
export type CheckRunBody = {
  name: string;
  details_url?: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure";
  output: { title: string };
};

/**
 * What the status says for a build: `in_progress` while it is diffed and while a change awaits
 * review (the title says how many), so a waiting change reads as pending, not as failed CI;
 * `failure` when a shot is rejected or the build errored (the title names the error); `success`
 * when every change is accepted or nothing changed. New shots wait for review like changes do
 * (PS-284). The counts and the waiting shots are in the PR comment and on the build page.
 */
function checkRunOf(
  build: SyncedBuild & { checkName: string },
  counts: BuildCounts,
  detailsUrl: string | undefined,
): CheckRunBody {
  const done =
    build.status !== "uploading" && build.status !== "processing" && build.status !== "changes";
  return {
    name: build.checkName,
    ...(detailsUrl && { details_url: detailsUrl }),
    status: done ? "completed" : "in_progress",
    ...(done && { conclusion: build.status === "passed" ? "success" : "failure" }),
    output: { title: titleOf(build, counts) },
  };
}

/** A status description is at most 140 characters. */
const STATUS_DESCRIPTION_MAX = 140;

export type StatusBody = {
  state: "pending" | "success" | "failure";
  context: string;
  description: string;
  target_url?: string;
};

/** The state as a commit status: `in_progress` is `pending`, the conclusions are kept. */
function statusOf(run: CheckRunBody): StatusBody {
  return {
    state: run.status === "in_progress" ? "pending" : (run.conclusion ?? "failure"),
    context: run.name,
    description: run.output.title.slice(0, STATUS_DESCRIPTION_MAX),
    ...(run.details_url && { target_url: run.details_url }),
  };
}

type BuildRow = SyncedBuild & {
  commitSha: string;
  checkRunId: number | null;
  repo: RepoName;
  /** "PixelSlash", or "PixelSlash / <project>" when the repo has several projects. */
  checkName: string;
  prNumber: number | null;
  comment: boolean;
};

async function loadBuild(db: Db, buildId: string): Promise<BuildRow | null> {
  const [row] = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      error: builds.error,
      commitSha: builds.commitSha,
      checkRunId: builds.checkRunId,
      prNumber: builds.prNumber,
      repo: projects.githubRepo,
      projectName: projects.name,
      orgId: projects.orgId,
      comment: projects.githubComment,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(eq(builds.id, buildId));
  // A repo stored before it was checked is skipped, not sent to GitHub.
  if (!row?.repo || !isRepoName(row.repo)) return null;
  // GitHub's owner and repo names ignore case, so `Acme/Web` and `acme/web` are one repo. Only the
  // org's own projects count: another org linking the same repo must not rename this one's check.
  const [linked] = await db
    .select({ n: count() })
    .from(projects)
    .where(
      and(
        eq(projects.orgId, row.orgId),
        eq(sql`lower(${projects.githubRepo})`, row.repo.toLowerCase()),
      ),
    );
  const { projectName, orgId: _orgId, ...rest } = row;
  return { ...rest, repo: row.repo, checkName: checkNameOf(projectName, linked?.n ?? 0) };
}

async function bodyOf(deps: CheckRunDeps, row: BuildRow): Promise<CheckRunBody> {
  const counts = (await countBuilds(deps.db, [row.id])).get(row.id) ?? emptyCounts();
  return checkRunOf(row, counts, detailsUrlOf(deps.publicUrl, row));
}

/** A commit status is a new entry on the commit, newest wins: there is no id to keep. */
async function syncStatus(deps: CheckRunDeps, client: GithubApp, row: BuildRow): Promise<void> {
  const status = statusOf(await bodyOf(deps, row));
  await client.request(row.repo, "POST", `/repos/${row.repo}/statuses/${row.commitSha}`, status);
}

/** What the check run a build was given before the status says as it is put to rest. */
const RETIRED_RUN = {
  status: "completed",
  conclusion: "neutral",
  output: {
    title: "Moved to the PixelSlash commit status",
    summary: "This build now reports as a commit status, whose Details link opens the build.",
  },
};

/**
 * A build synced while the App posted check runs holds one, maybe still `in_progress`: complete it
 * once, so it does not spin. The id is cleared first, by the one sync that finds it set, so two
 * syncs do not both send it and a failed call is not retried on every sync after.
 */
async function retireCheckRun(deps: CheckRunDeps, app: GithubApp, row: BuildRow): Promise<void> {
  const id = row.checkRunId;
  if (id === null) return;
  const claimed = await deps.db
    .update(builds)
    .set({ checkRunId: null })
    .where(and(eq(builds.id, row.id), eq(builds.checkRunId, id)))
    .returning({ id: builds.id });
  if (claimed.length === 0) return;
  await app.request(row.repo, "PATCH", `/repos/${row.repo}/check-runs/${id}`, RETIRED_RUN);
}

/**
 * Bring each build's commit status and its PR's comment up to the current state. Does nothing when
 * neither the App nor the token is configured or the build's project has no repo, and never
 * throws: the calls are separate, so one failing leaves the others.
 */
export async function syncCheckRuns(deps: CheckRunDeps, buildIds: Iterable<string>): Promise<void> {
  const { app, token } = deps;
  const client = app ?? token;
  if (!client) return;
  for (const buildId of new Set(buildIds)) {
    const row = await loadBuild(deps.db, buildId).catch((error: unknown) => {
      failed(`build ${buildId}`, error);
      return null;
    });
    if (!row) continue;
    if (app)
      await attempt(`github check run for build ${buildId}`, () => retireCheckRun(deps, app, row));
    // A 403 here is an App set up before it posted statuses: the owner grants commit statuses
    // write. Logged, not reported, like the comment's below.
    await attempt(
      `github commit status for build ${buildId}`,
      () => syncStatus(deps, client, row),
      forbidden,
    );
    // A 403 here is a server whose App or token was set up before the comment: the owner has to
    // grant pull requests write. That is logged, not reported, or every PR build would be an event.
    await attempt(
      `github PR comment for build ${buildId}`,
      () => syncPrComment(deps, client, row),
      forbidden,
    );
  }
}

const forbidden = (error: unknown) => error instanceof GithubError && error.status === 403;

async function attempt(
  what: string,
  run: () => Promise<void>,
  expected: (error: unknown) => boolean = () => false,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    failed(what, error, expected(error));
  }
}

function failed(what: string, error: unknown, expected = false): void {
  warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  if (!expected) reportError(error, { area: "github" });
}
