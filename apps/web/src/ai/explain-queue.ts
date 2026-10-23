import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type Build, getBuild } from "#/db/builds";
import { chunk } from "#/db/chunks";
import type { Db } from "#/db/db";
import { projectModelFor } from "#/db/models";
import { refreshBuildStatus } from "#/db/review";
import { builds, projects, snapshots } from "#/db/schema";
import { msBetween, recordExplained } from "#/db/server-timings";
import { projectOf } from "#/diff/build-writes";
import { warn } from "#/lib/log";
import type { BlobStore } from "#/storage/blobs";
import { type ExplainDeps, type Shot, messageOf, shotsToExplain, storeShot } from "./explain";
import type { ModelFetch } from "./model";
import { summarizeBuild } from "./summary";

/**
 * Explaining runs off a queue (ob 1875), not in the finalise request. The diff spends most of that
 * request's `DIFF_BUDGET_MS`, and one region call to a reasoning model takes about 12 s, so inline
 * every shot timed out. Now the finalise gives its verdict, marks each changed shot queued and sends
 * one job per shot; the consumer (`src/server.ts`) explains each shot with the whole
 * `MODEL_TIMEOUT_MS` per call, its regions at once. The shot that settles last claims the build's
 * summary and writes it. A Cloudflare Queue in production; miniflare runs the same consumer on the
 * self-host.
 *
 * A build is never left explaining: a shot the model could not explain is tried `EXPLAIN_ATTEMPTS`
 * times and then stores why, and one still queued after `EXPLAIN_STALE_MS` (its consumer died
 * every time) is shown as stopped.
 */

export type ExplainJob =
  /** `queuedAt` (ms) names the queueing: a re-run queues the shot anew, and an old job then owns nothing. */
  | { kind: "shot"; buildId: string; snapshotId: string; queuedAt: number }
  | { kind: "summary"; buildId: string };

type ShotJob = Extract<ExplainJob, { kind: "shot" }>;

/** The producer side of the queue binding; a test passes one in memory. */
export type ExplainQueue = { sendBatch(messages: { body: ExplainJob }[]): Promise<unknown> };

/** One delivered job, as a Cloudflare Queue hands it over. */
export type ExplainDelivery = {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

/** Tries per shot before it stores why; the queue's `max_retries` is above it (wrangler.jsonc). */
export const EXPLAIN_ATTEMPTS = 3;

/** Seconds before a shot the model failed is tried again, times the attempt. */
const RETRY_DELAY_S = 10;

/** A queue send carries at most 100 messages. */
const SEND_LIMIT = 100;

type QueueDeps = {
  db: Db;
  now?: (() => number) | undefined;
  modelKeySecret?: string | undefined;
  explainQueue?: ExplainQueue | undefined;
};

/**
 * After a run's verdict: clear the summary of what was measured before, mark the build's changed,
 * undecided, unexplained shots (or `only` those) queued, and send a job for each. With nothing to
 * explain, the summary is the one job. A project with no model queues nothing and sends nothing.
 * Never throws: a send that fails marks the shots failed, naming why, and the verdict stands.
 */
export async function queueExplain(
  deps: QueueDeps,
  build: Build,
  { only }: { only?: string[] } = {},
): Promise<void> {
  // The shots queued and not yet sent: a failure gives up these, and not one already sent.
  const unsent: string[] = [];
  let sentAny = false;
  try {
    await deps.db
      .update(builds)
      .set({ aiSummary: null, aiSummaryQueuedAt: null, aiSummaryClaimedAt: null })
      .where(eq(builds.id, build.id));
    const model = await projectModelFor(deps.db, build.projectId, deps.modelKeySecret);
    if (!model) return;
    unsent.push(...(await shotsToExplain(deps.db, build.id, only)).map((shot) => shot.id));
    const { at, summaryDue } = await markQueued(deps, build, unsent);
    const jobs: ExplainJob[] = unsent.map((snapshotId) => ({
      kind: "shot",
      buildId: build.id,
      snapshotId,
      queuedAt: at.getTime(),
    }));
    if (jobs.length === 0 && summaryDue) jobs.push({ kind: "summary", buildId: build.id });
    if (jobs.length > 0 && !deps.explainQueue) throw new Error("no explain queue is bound");
    for (let from = 0; from < jobs.length; from += SEND_LIMIT) {
      await deps.explainQueue?.sendBatch(
        jobs.slice(from, from + SEND_LIMIT).map((body) => ({ body })),
      );
      unsent.splice(0, SEND_LIMIT);
      sentAny = true;
    }
  } catch (e) {
    const failure = `explaining could not be queued: ${messageOf(e)}`;
    warn(`build ${build.id}: ${failure}`);
    await giveUp(deps.db, build.id, { ids: unsent, failure, noSummary: !sentAny }).catch(
      () => undefined,
    );
  }
}

/** Mark the shots queued now, and the summary when one is due; returns when, and whether it is. */
async function markQueued(
  deps: QueueDeps,
  build: Build,
  ids: string[],
): Promise<{ at: Date; summaryDue: boolean }> {
  const at = new Date((deps.now ?? Date.now)());
  for (const part of chunk(ids, 2))
    await deps.db
      .update(snapshots)
      .set({ aiQueuedAt: at, aiError: null })
      .where(inArray(snapshots.id, part));
  // A default-branch build is accepted on finalise and reviewed by no one: it gets no summary.
  const summaryDue = build.branch !== (await projectOf(deps.db, build)).defaultBranch;
  if (summaryDue)
    await deps.db.update(builds).set({ aiSummaryQueuedAt: at }).where(eq(builds.id, build.id));
  return { at, summaryDue };
}

/**
 * The queue did not take these shots' jobs: nothing will explain them. With no job sent, nothing
 * writes the summary either; with some sent, the last of those still does.
 */
async function giveUp(
  db: Db,
  buildId: string,
  { ids, failure, noSummary }: { ids: string[]; failure: string; noSummary: boolean },
): Promise<void> {
  for (const part of chunk(ids, 3))
    await db
      .update(snapshots)
      .set({ aiQueuedAt: null, aiError: failure })
      .where(and(inArray(snapshots.id, part), isNotNull(snapshots.aiQueuedAt)));
  if (noSummary)
    await db.update(builds).set({ aiSummaryQueuedAt: null }).where(eq(builds.id, buildId));
}

export type ConsumerDeps = {
  db: Db;
  /** An org's images: each job reads its own org's, never another's. */
  blobs: (orgId: string) => BlobStore;
  now?: (() => number) | undefined;
  /** The model's transport; a test passes a stub. Never a real endpoint in tests. */
  modelFetch?: ModelFetch | undefined;
  modelKeySecret?: string | undefined;
};

function jobOf(body: unknown): ExplainJob | null {
  if (typeof body !== "object" || body === null) return null;
  const kind: unknown = Reflect.get(body, "kind");
  const buildId: unknown = Reflect.get(body, "buildId");
  const snapshotId: unknown = Reflect.get(body, "snapshotId");
  const queuedAt: unknown = Reflect.get(body, "queuedAt");
  if (typeof buildId !== "string") return null;
  if (kind === "summary") return { kind, buildId };
  if (kind === "shot" && typeof snapshotId === "string" && typeof queuedAt === "number")
    return { kind, buildId, snapshotId, queuedAt };
  return null;
}

/**
 * The queue's consumer: each job at once. A shot the model explained nothing of is retried while
 * it has tries left, then stores why; an error of the consumer's own is the same. Every job ends
 * acked or retried, so no delivery is left to the queue's own retry count.
 */
export async function consumeExplain(
  deps: ConsumerDeps,
  deliveries: readonly ExplainDelivery[],
): Promise<void> {
  await Promise.all(
    deliveries.map(async (delivery) => {
      const job = jobOf(delivery.body);
      if (!job) return delivery.ack();
      const last = delivery.attempts >= EXPLAIN_ATTEMPTS;
      try {
        if (job.kind === "shot" && (await explainJob(deps, job, last)) === "retry")
          return delivery.retry({ delaySeconds: RETRY_DELAY_S * delivery.attempts });
        await summarizeWhenExplained(deps, job.buildId);
        delivery.ack();
      } catch (e) {
        if (!last) return delivery.retry({ delaySeconds: RETRY_DELAY_S * delivery.attempts });
        warn(`build ${job.buildId}: explaining stopped: ${messageOf(e)}`);
        if (job.kind === "shot") await giveUpShot(deps, job, messageOf(e)).catch(() => undefined);
        await summarizeWhenExplained(deps, job.buildId).catch(() => undefined);
        delivery.ack();
      }
    }),
  );
}

/** Only the job's own queueing: a re-run that queued the shot again keeps its mark. */
async function giveUpShot(deps: ConsumerDeps, job: ShotJob, failure: string): Promise<void> {
  const settled = await deps.db
    .update(snapshots)
    .set({ aiQueuedAt: null, aiError: failure })
    .where(and(eq(snapshots.id, job.snapshotId), eq(snapshots.aiQueuedAt, new Date(job.queuedAt))))
    .returning({ id: snapshots.id });
  if (settled.length > 0) await recordSettled(deps, job);
}

/** A shot of the job's queueing settled: the build's explanation step has run until now (ob 1792). */
const recordSettled = (deps: ConsumerDeps, job: ShotJob) =>
  recordExplained(deps.db, job.buildId, { queuedAt: job.queuedAt, now: (deps.now ?? Date.now)() });

/** The build's org and its project's model; null when either is gone. */
async function ownerOf(deps: ConsumerDeps, buildId: string) {
  const [owner] = await deps.db
    .select({ projectId: builds.projectId, orgId: projects.orgId })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(eq(builds.id, buildId));
  const model = owner && (await projectModelFor(deps.db, owner.projectId, deps.modelKeySecret));
  return owner && model ? { orgId: owner.orgId, model } : null;
}

/** Explain one queued shot; `retry` when the model explained nothing and tries are left. */
async function explainJob(
  deps: ConsumerDeps,
  job: ShotJob,
  last: boolean,
): Promise<"done" | "retry"> {
  const [shot] = await deps.db.select().from(snapshots).where(eq(snapshots.id, job.snapshotId));
  // Settled by another delivery of the same job, or measured again and queued anew.
  if (
    !shot?.aiQueuedAt ||
    shot.aiQueuedAt.getTime() !== job.queuedAt ||
    shot.buildId !== job.buildId
  )
    return "done";
  const outcome = await outcomeOf(deps, shot, job.buildId, last);
  if (outcome === "retry") return "retry";
  // Only this queueing's job settles the shot: a re-run that queued it again owns the new one.
  const settled = await deps.db
    .update(snapshots)
    .set({ aiQueuedAt: null, aiError: outcome.aiError })
    .where(and(eq(snapshots.id, shot.id), eq(snapshots.aiQueuedAt, shot.aiQueuedAt)))
    .returning({ id: snapshots.id });
  if (settled.length > 0) await recordSettled(deps, job);
  if (outcome.passed) await refreshBuildStatus(deps.db, job.buildId);
  return "done";
}

/** What settles the shot: nothing to ask, its notes, or (out of tries) why it has none. */
async function outcomeOf(
  deps: ConsumerDeps,
  shot: Shot,
  buildId: string,
  last: boolean,
): Promise<"retry" | { aiError: string | null; passed: boolean }> {
  const owner = await ownerOf(deps, buildId);
  // A reviewer decided it, or the project's model was removed, while it waited.
  if (!owner || shot.reviewState !== "pending" || shot.aiReview)
    return { aiError: null, passed: false };
  const answer = await answerShot(deps, owner, shot, buildId);
  if (answer.stored) return { aiError: null, passed: answer.passed };
  if (!last) return "retry";
  warn(`build ${buildId}: the project's model explained nothing for a shot: ${answer.failure}`);
  return { aiError: answer.failure, passed: false };
}

type Answer = { stored: boolean; passed: boolean; failure: string };

/** Ask the project's model about the shot's regions and store what it said. */
async function answerShot(
  deps: ConsumerDeps,
  owner: NonNullable<Awaited<ReturnType<typeof ownerOf>>>,
  shot: Shot,
  buildId: string,
): Promise<Answer> {
  const now = deps.now ?? Date.now;
  const explain: ExplainDeps = {
    db: deps.db,
    blobs: deps.blobs(owner.orgId),
    now,
    modelFetch: deps.modelFetch,
    modelKeySecret: deps.modelKeySecret,
  };
  try {
    const { stored, passed, failure } = await storeShot(explain, owner.model, shot, {
      buildId,
      now,
    });
    return { stored, passed, failure: failure ?? "the model explained no region" };
  } catch (e) {
    return { stored: false, passed: false, failure: messageOf(e) };
  }
}

/**
 * Once no shot of the build is still queued, the first to see it claims the summary and writes it:
 * one call, with the notes every shot now has. The summary stays pending until it is written or
 * fails, so the page keeps waiting for it. A re-run that queues the build again while the call is
 * out wins: the late answer is stored only against the queueing it claimed. A shot whose consumer
 * died holds the summary back until it is stale; then the page offers Regenerate.
 */
async function summarizeWhenExplained(deps: ConsumerDeps, buildId: string): Promise<void> {
  const [waiting] = await deps.db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(and(eq(snapshots.buildId, buildId), isNotNull(snapshots.aiQueuedAt)))
    .limit(1);
  if (waiting) return;
  const [held] = await deps.db
    .update(builds)
    .set({ aiSummaryClaimedAt: new Date((deps.now ?? Date.now)()) })
    .where(
      and(
        eq(builds.id, buildId),
        isNotNull(builds.aiSummaryQueuedAt),
        isNull(builds.aiSummaryClaimedAt),
      ),
    )
    .returning({ projectId: builds.projectId, queuedAt: builds.aiSummaryQueuedAt });
  if (!held?.queuedAt) return;
  const queuedAt = held.queuedAt;
  const now = deps.now ?? Date.now;
  const began = now();
  try {
    await summarizeBuild(deps, await getBuild(deps.db, held.projectId, buildId), { queuedAt });
  } finally {
    await deps.db
      .update(builds)
      .set({
        aiSummaryQueuedAt: null,
        aiSummaryClaimedAt: null,
        summaryMs: msBetween(began, now()),
        finishedAt: new Date(),
      })
      .where(and(eq(builds.id, buildId), eq(builds.aiSummaryQueuedAt, queuedAt)));
  }
}
