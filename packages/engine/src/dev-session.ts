import { explainIteration } from "./dev-explain.ts";
import { type DevJudgeDeps, judgeIteration } from "./dev-judge.ts";
import type { DevActions, DevMode } from "./dev-page.ts";
import {
  type DevFeature,
  type DevRef,
  type FeatureSource,
  readSpec,
  resolveRefs,
} from "./dev-refs.ts";
import { type FetchMain, runIteration } from "./dev-run.ts";
import {
  type DevDifferences,
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
  /**
   * `--judge`: the design-system judge when there is a `dsDir`, and on a target with a spec or
   * refs, the judge's list of how the shot differs from them (ob 1741).
   */
  judge: { dsDir: string | undefined; deps: DevJudgeDeps } | undefined;
  /** The target's `features` entry; unset when it has none. */
  feature: FeatureSource | undefined;
  /** `--refresh-refs`: fetch the Figma refs again on the first resolve, not only on `f`. */
  refreshRefs: boolean;
  onRun: (it: DevIteration) => void;
  onJudge: (it: DevIteration, judge: DevJudge) => void;
  onExplain: (it: DevIteration, differences: DevDifferences) => void;
  /** The refs as resolved, at the start and after each refresh (to say which were skipped). */
  onRefs: (refs: DevRef[]) => void;
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
  let refs: Promise<DevRef[]> | undefined;
  const resolveFeature = async (refresh: boolean): Promise<DevFeature | null> => {
    const src = opts.feature;
    if (!src) return null;
    // Resolved once and held, so a poll of the page never fetches; `f` refetches.
    // A promise, so a poll that lands mid-resolve waits on it rather than fetching again.
    if (!refs || refresh) {
      refs = resolveRefs(src.def, { ...src, refresh: refresh || opts.refreshRefs });
      // A failed resolve is not held: the next ask tries again.
      const mine = refs;
      void refs.then(opts.onRefs, () => {
        if (refs === mine) refs = undefined;
      });
    }
    // The spec is read on every ask: it is edited while dev runs.
    return { spec: await readSpec(src.def), refs: await refs };
  };
  const explain = async (it: DevIteration) => {
    if (!opts.judge) return;
    const feature = await resolveFeature(false);
    if (!feature || (!feature.spec && feature.refs.length === 0)) return;
    opts.onExplain(it, await explainIteration(it, feature, opts.judge.deps));
  };
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
      if (opts.judge?.dsDir)
        opts.onJudge(it, await judgeIteration(it, opts.judge.dsDir, opts.judge.deps));
      await explain(it);
      return it;
    } catch (e) {
      opts.onError(e);
      return undefined;
    } finally {
      mode = { ...mode, running: false };
    }
  };
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const run = () => queue(once);
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
    feature: () => resolveFeature(false),
    // Through the queue, so a refetch never swaps a ref under a run that is reading it.
    refreshRefs: () => queue(() => resolveFeature(true)),
    idle: async () => {
      await chain;
    },
  };
}
