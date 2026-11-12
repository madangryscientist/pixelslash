import { type Build, getBuild } from "#/db/builds";
import type { Db } from "#/db/db";
import { finishRun } from "#/db/verdict";
import { recordRun, runFields } from "#/db/server-timings";
import { queueExplain } from "#/ai/explain-queue";
import { markErrored } from "./build-writes";
import type { ProcessDeps, ProcessResult } from "./process";
import type { RunTimer } from "./run-timer";

/**
 * How a diff run ends its build (PS-392). Both writes are fenced on the claim the run holds
 * (`processingStartedAt`, see `claim`): a run that outlived its claim and found its build taken
 * over writes nothing, and answers with what the build says now.
 */

/** What the build says now, as the reply of a run that did not write its end. */
export async function currentResult(db: Db, build: Build): Promise<ProcessResult> {
  const current = await getBuild(db, build.projectId, build.id);
  return { status: current.status, error: current.error, unmeasured: 0 };
}

/**
 * The verdict: written, its timings recorded, the shots explained off the request (ob 1875). A run
 * that lost its claim records and queues nothing. `only`: the shots a re-diff moved.
 */
export async function endRun(
  deps: ProcessDeps,
  build: Build,
  timer: RunTimer,
  only?: string[],
): Promise<ProcessResult> {
  const status = await finishRun(deps.db, build.id, timer.startedAt);
  if (status === null) return currentResult(deps.db, build);
  await recordRun(deps.db, build.id, timer.ended());
  // After the verdict: the model explains each shot, then writes the summary (ob 1668). It never
  // throws, so it cannot mark the build errored.
  await queueExplain(deps, build, only ? { only } : {});
  return { status, error: null, unmeasured: 0 };
}

/** The error, with the run's timings, if this run still holds the build. */
export async function endErrored(
  db: Db,
  build: Build,
  e: unknown,
  timer: RunTimer,
): Promise<ProcessResult> {
  const timings = runFields(timer.ended());
  const error = await markErrored(db, build, e, { startedAt: timer.startedAt, timings });
  if (error === null) return currentResult(db, build);
  return { status: "errored", error, unmeasured: 0 };
}
