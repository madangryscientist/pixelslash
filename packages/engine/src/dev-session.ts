import { type DevJudgeDeps, judgeIteration } from "./dev-judge.ts";
import type { DevActions, DevMode } from "./dev-page.ts";
import { type FetchMain, runIteration } from "./dev-run.ts";
import {
  type DevIteration,
  type DevJudge,
  type DevStore,
  latestIteration,
  pinIteration,
  unpinIteration,
} from "./dev-store.ts";
import type { CaptureSession } from "./snapshot.ts";

/**
 * The state of one `pixelslash dev` session (ob 1740): what it compares with, and one run at a
 * time. The watcher, the keys and the live page's buttons all go through these actions, so a save
 * during a run and a click on Run never shoot side by side.
 */

export type DevSessionOptions = {
  store: DevStore;
  /** Already narrowed to the target. */
  session: CaptureSession;
  target: string;
  maxBytes: number;
  /** How main's baselines are fetched; unset when there are no credentials. */
  main: FetchMain | undefined;
  /** Why `main` is unset, said when `--against main` (or `m`) asks for it. */
  noMain: string;
  againstMain: boolean;
  judge: { dsDir: string; deps: DevJudgeDeps } | undefined;
  onRun: (it: DevIteration) => void;
  onJudge: (it: DevIteration, judge: DevJudge) => void;
  /** A run that threw (the page went down mid-session): reported, and the session carries on. */
  onError: (e: unknown) => void;
};

export type DevController = DevActions & { idle: () => Promise<void> };

/** Ask for main: on when there is a way to fetch it, else stay local and say why. */
function wantMain(opts: DevSessionOptions): DevMode {
  if (opts.main) return { against: "main", note: null, running: false };
  return { against: "previous", note: opts.noMain, running: false };
}

export function devController(opts: DevSessionOptions): DevController {
  let mode: DevMode = opts.againstMain
    ? wantMain(opts)
    : { against: "previous", note: null, running: false };
  let chain: Promise<unknown> = Promise.resolve();
  const once = async (): Promise<DevIteration | undefined> => {
    mode = { ...mode, running: true };
    try {
      const it = await runIteration({
        store: opts.store,
        session: opts.session,
        target: opts.target,
        maxBytes: opts.maxBytes,
        main: mode.against === "main" ? opts.main : undefined,
        note: mode.note ?? undefined,
      });
      opts.onRun(it);
      if (opts.judge) opts.onJudge(it, await judgeIteration(it, opts.judge.dsDir, opts.judge.deps));
      return it;
    } catch (e) {
      opts.onError(e);
      return undefined;
    } finally {
      mode = { ...mode, running: false };
    }
  };
  const run = () => {
    const next = chain.then(once);
    chain = next;
    return next;
  };
  return {
    run,
    pin: async () => {
      const latest = await latestIteration(opts.store, opts.target);
      return latest ? pinIteration(opts.store, latest.id) : undefined;
    },
    unpin: () => unpinIteration(opts.store),
    toggleMain: async () => {
      const running = mode.running;
      mode =
        mode.against === "main"
          ? { against: "previous", note: null, running }
          : { ...wantMain(opts), running };
      return mode;
    },
    mode: () => mode,
    idle: async () => {
      await chain;
    },
  };
}
