import { AsyncLocalStorage } from "node:async_hooks";
import { newUploadProgress, type UploadProgress } from "@hackcove/pixelslash-engine";

/**
 * Exit 7: an unexpected error, a bug in pixelslash. Not 1, which is reserved for NEW violations on
 * Branch (invariant 3), and not a code a runner already reads as a verdict or a refusal.
 */
export const INTERNAL_EXIT = 7;

export type Stage = "capture" | "compare" | "upload";

/** What the run knows about itself, for the one line a crash writes (PS-223). */
export type RunState = { stage: Stage | undefined; upload: UploadProgress };

const states = new AsyncLocalStorage<RunState>();

/** A fresh record of a run's stage and upload; `inState` makes it the one `enterStage` and an upload write to. */
export function newState(stage: Stage | undefined): RunState {
  return { stage, upload: newUploadProgress() };
}

export function inState<T>(state: RunState, work: () => Promise<T>): Promise<T> {
  return states.run(state, work);
}

/** The stage the run has reached, when it is run through `guarded`. */
export function enterStage(stage: Stage): void {
  const state = states.getStore();
  if (state) state.stage = stage;
}

/** The record an upload fills in: the run's own under `guarded`, else one nobody reads. */
export function uploadProgress(): UploadProgress {
  return states.getStore()?.upload ?? newUploadProgress();
}

/** The sentence a runner greps for and obeys; the help text of every command that can exit 7 says it too. */
export const ESCALATE = `Exit ${INTERNAL_EXIT} is a bug in pixelslash (a crash, or a shot it could not diff): a runner that sees it must escalate to the PixelSlash planner.`;

/** What reached the server: `nothing was uploaded`, or how far an upload got. Never claims more. */
export function uploadLine(p: UploadProgress): string {
  if (!p.opened) return "nothing was uploaded";
  if (p.finalised) return `the upload had finished: ${p.sent}/${p.total} shots sent`;
  return `upload incomplete: ${p.sent}/${p.total} shots sent`;
}

/** The first lines of a failure: the one greppable `FAILED` line, what reached the server, who must act. */
export function failedLines(
  command: string,
  stage: Stage | undefined,
  message: string,
  upload: UploadProgress,
): string[] {
  const where = stage ? `${stage}: ` : "";
  return [`pixelslash: FAILED ${command}: ${where}${message}`, uploadLine(upload), ESCALATE];
}

const firstLine = (message: string): string => message.split("\n", 1)[0] ?? "";

/** The lines `guarded` writes for an unexpected error, the stack last: it is a bug, so it is kept. */
export function crashLines(command: string, e: unknown, state: RunState): string[] {
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error && e.stack ? e.stack : message;
  const head = failedLines(command, state.stage, firstLine(message), state.upload);
  return [...head, stack];
}
