import { and, desc, eq, sql } from "drizzle-orm";
import { explaining } from "#/ai/explain-pending";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/build-counts";
import type { Db } from "#/db/db";
import type { AiSummary } from "#/db/diff-json";
import { type ChangedShot, mostChangedShots } from "#/db/open-shots";
import { builds } from "#/db/schema";
import { prComments } from "#/db/schema-pr-comments";
import { type GithubApp, GithubError, type RepoName, field } from "./app";
import { type SyncedBuild, countsTable, detailsUrlOf, titleOf } from "./build-text";

/*
 * The PixelSlash comment on a pull request (PS-82): one per PR, created by the first build that
 * names the PR and edited in place by each later one, never a new comment per push. It carries the
 * project model's summary of the build (or says there is none), the counts, the most changed shots
 * as links and the link to the build page. Text and links only: no screenshot ever goes to GitHub
 * (invariant 4). GitHub is told, never asked: the caller logs a failed call and the build's
 * verdict and the request that synced it are untouched.
 */

/** Marks the comment as ours, for a person reading the source and for anything that lists them. */
export const COMMENT_MARKER = "<!-- pixelslash:pr-comment -->";

/** How many shots the comment links; the build page has the rest. */
const NAMED_SHOTS = 5;

type PrCommentDeps = { db: Db; publicUrl: string | undefined };

/** What the comment needs of the synced build; the check run's row has all of it. */
export type PrCommentBuild = SyncedBuild & {
  commitSha: string;
  repo: RepoName;
  prNumber: number | null;
  /** The project's setting: off sends no comment. */
  comment: boolean;
};

/**
 * Text from a model, a CLI or a person goes into a Markdown comment: `@` and the characters that
 * make links, HTML or code are defused, so nothing in it can notify someone or change the layout.
 */
export function plain(text: string): string {
  return text.replace(/[\\`[\]<>]/g, "\\$&").replaceAll("@", "@​");
}

const shotLabel = (shot: ChangedShot) => `${shot.name} (${shot.viewport}, ${shot.theme})`;

function shotLines(shots: ChangedShot[], pageUrl: string | undefined): string[] {
  if (shots.length === 0) return [];
  const lines = shots.map((shot) => {
    const label = plain(shotLabel(shot));
    const named = pageUrl ? `[${label}](${pageUrl}/snapshots/${shot.id})` : label;
    return `- ${named}: ${shot.kind === "new" ? "new shot" : `${shot.changedPixels} px changed`}`;
  });
  return ["", `Most changed shots:`, ...lines];
}

/** The model's summary, or the plain statement that there is none: never an invented one. */
function summaryLines(summary: AiSummary | null, pending: boolean): string[] {
  if (summary) {
    const sentences = summary.sentences.map((s) => plain(s.text));
    const match = summary.match ? [`Against the brief: ${plain(summary.match.text)}`] : [];
    return [sentences.join(" "), ...(match.length > 0 ? ["", ...match] : [])];
  }
  if (pending) return ["The summary is being written; this comment is edited when it is ready."];
  return [
    "Summary skipped: this project has no model that made one. The counts and shots below were measured.",
  ];
}

type CommentFacts = {
  build: PrCommentBuild;
  counts: BuildCounts;
  summary: AiSummary | null;
  summaryPending: boolean;
  shots: ChangedShot[];
  pageUrl: string | undefined;
};

/** The comment's Markdown. */
export function commentOf({
  build,
  counts,
  summary,
  summaryPending,
  shots,
  pageUrl,
}: CommentFacts): string {
  const failedBuild = build.status === "errored";
  return [
    COMMENT_MARKER,
    `### PixelSlash: ${plain(titleOf(build, counts))}`,
    "",
    ...(failedBuild ? [] : [...summaryLines(summary, summaryPending), ""]),
    ...(failedBuild ? [] : [...countsTable(counts), ...shotLines(shots, pageUrl)]),
    "",
    `Build of \`${build.commitSha.slice(0, 7)}\`${pageUrl ? `: [Review the build](${pageUrl})` : ""}`,
  ].join("\n");
}

/**
 * Only the newest build of the PR speaks for it: an older one deciding late does not overwrite.
 * `created_at` has a second's resolution, so the insert order (`rowid`) breaks a tie; the random id cannot.
 */
async function isNewestOfPr(
  db: Db,
  build: PrCommentBuild & { projectId: string },
): Promise<boolean> {
  if (build.prNumber === null) return false;
  const [newest] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.projectId, build.projectId), eq(builds.prNumber, build.prNumber)))
    .orderBy(desc(builds.createdAt), desc(sql`${builds}.rowid`))
    .limit(1);
  return newest?.id === build.id;
}

type CommentKey = ReturnType<typeof keyOfComment>;

const keyOfComment = (projectId: string, prNumber: number) =>
  and(eq(prComments.projectId, projectId), eq(prComments.prNumber, prNumber));

/** The body for a build: its counts, its summary as it stands, its most changed shots. */
async function bodyOf(deps: PrCommentDeps, build: PrCommentBuild): Promise<string> {
  const { db } = deps;
  const [facts] = await db
    .select({ aiSummary: builds.aiSummary, queuedAt: builds.aiSummaryQueuedAt })
    .from(builds)
    .where(eq(builds.id, build.id));
  return commentOf({
    build,
    counts: (await countBuilds(db, [build.id])).get(build.id) ?? emptyCounts(),
    summary: facts?.aiSummary ?? null,
    summaryPending: explaining(facts?.queuedAt ?? null, Date.now()),
    shots: await mostChangedShots(db, build.id, NAMED_SHOTS),
    pageUrl: detailsUrlOf(deps.publicUrl, build),
  });
}

/** Edit the stored comment. False when GitHub no longer has it (deleted): the row is dropped too. */
async function editHeld(
  db: Db,
  edit: (id: number) => Promise<unknown>,
  key: CommentKey,
): Promise<boolean> {
  const [held] = await db.select({ id: prComments.commentId }).from(prComments).where(key);
  if (!held) return false;
  try {
    await edit(held.id);
    return true;
  } catch (error) {
    // Deleted on GitHub: it is made again by the caller. Any other failure is the caller's to log.
    if (!(error instanceof GithubError && error.status === 404)) throw error;
    await db.delete(prComments).where(key);
    return false;
  }
}

/**
 * Create or edit the PR's comment for a build that has a verdict. Nothing for a build with no PR,
 * a project that turned the comment off, a build still being diffed, or one that a newer build of
 * the PR has superseded. A comment someone deleted is created again.
 */
export async function syncPrComment(
  deps: PrCommentDeps,
  client: GithubApp,
  build: PrCommentBuild,
): Promise<void> {
  const { db } = deps;
  const { prNumber, repo } = build;
  if (prNumber === null || !build.comment) return;
  if (build.status === "uploading" || build.status === "processing") return;
  if (!(await isNewestOfPr(db, build))) return;

  const body = await bodyOf(deps, build);
  const key = keyOfComment(build.projectId, prNumber);
  const edit = (id: number) =>
    client.request(repo, "PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
  if (await editHeld(db, edit, key)) return;

  const created = await client.request(repo, "POST", `/repos/${repo}/issues/${prNumber}/comments`, {
    body,
  });
  const id = Number(field(created, "id"));
  const stored = await db
    .insert(prComments)
    .values({ projectId: build.projectId, prNumber, commentId: id })
    .onConflictDoNothing()
    .returning({ id: prComments.commentId });
  if (stored.length > 0) return;
  // Another sync made the PR's comment first: that one is the PR's, so it gets this state and ours goes.
  // Ours goes first: if the edit then fails, the PR still has the one comment.
  await client.request(repo, "DELETE", `/repos/${repo}/issues/comments/${id}`);
  await editHeld(db, edit, key);
}
