import {
  DEFAULT_MAX_BYTES,
  DEFAULT_QUIET_MS,
  type DevController,
  type DevIteration,
  type DevJudge,
  type DevLock,
  type DevStore,
  type FeatureSource,
  UsageError,
  claimSession,
  debounce,
  devController,
  ensureIgnored,
  explainIteration,
  judgeIteration,
  loadFeature,
  notIgnored,
  runIteration,
  serveDevPage,
  watchTree,
} from "@hackcove/pixelslash-engine";
import { dirname } from "node:path";
import { attachTo } from "./dev-attach.ts";
import { type DevArgs, type DevDeps, jsonOf, lineOf } from "./dev.ts";
import { type DevTarget, mainSource, openTarget, prepareTarget } from "./dev-setup.ts";
import { checkJudge, differencesLine, featureSource, refLines } from "./dev-spec.ts";
import type { Io } from "./run.ts";

/**
 * The `pixelslash dev` session itself (ob 1740): one browser held open on the target, a run per
 * burst of saves, the live page, and the keys. `--once` is the same run without the loop.
 */

/** Where keys come from: the terminal, or a test's emitter. */
export type KeyInput = {
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  off(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  setRawMode?: (raw: boolean) => unknown;
  isTTY?: boolean;
  resume?: () => unknown;
  pause?: () => unknown;
};

/** Call `onKey` per key pressed; returns the undo. Ctrl-C arrives as `q` in raw mode. */
export function onKeys(input: KeyInput, onKey: (key: string) => void): () => void {
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) input.setRawMode?.(true);
  input.resume?.();
  const fn = (chunk: Buffer | string) => {
    for (const ch of String(chunk)) onKey(ch === "\u0003" ? "q" : ch.toLowerCase());
  };
  input.on("data", fn);
  return () => {
    input.off("data", fn);
    if (raw) input.setRawMode?.(false);
    input.pause?.();
  };
}

type Warn = (m: string) => void;

const warnTo =
  (io: Io): Warn =>
  (m: string) =>
    io.stderr.write(`${m}\n`);
const sayTo = (io: Io) => (m: string) => io.stdout.write(`${m}\n`);
const noop = () => {};

function judgeLine(judge: DevJudge): string {
  if (judge.status === "skipped") return `skip: ${judge.reason}`;
  if (judge.status === "failed") return `judge failed: ${judge.reason}`;
  const notes = judge.notes.map((n) => `  ${n.name} (${n.shot}): ${n.component}: ${n.reason}`);
  return [`judge: ${judge.notes.length} notes`, ...notes].join("\n");
}

/** One iteration through a browser opened for it and closed after. */
async function onceRun(
  t: DevTarget,
  args: DevArgs,
  deps: DevDeps,
  { store, warn }: { store: DevStore; warn: Warn },
): Promise<DevIteration> {
  const src = args.flags.against === "main" ? await mainSource(args, deps, warn) : undefined;
  const session = await openTarget(t, deps, warn);
  try {
    return await runIteration({
      store,
      session,
      target: t.target,
      maxBytes: DEFAULT_MAX_BYTES,
      main: src?.main,
      note: src?.noMain || undefined,
    });
  } finally {
    await session.close();
  }
}

/** `--once`: one run, no page and no watcher; `--json` prints the iteration. */
/** `--judge` on one run: the design system with `--ds`, then the feature's spec and refs. */
async function judgeOnce(
  it: DevIteration,
  at: { args: DevArgs; src: FeatureSource | undefined; warn: (line: string) => void },
  deps: DevDeps,
) {
  const { args, src, warn } = at;
  if (args.flags.ds) await judgeIteration(it, args.flags.ds, deps);
  if (!src) return;
  const feature = await loadFeature(src, args.refreshRefs);
  for (const line of refLines(feature.refs)) warn(line);
  if (feature.spec || feature.refs.length > 0) await explainIteration(it, feature, deps);
}

/** The run's line, then what the judges said. */
function textOf(it: DevIteration): string {
  const lines = [lineOf(it, null)];
  if (it.judge) lines.push(judgeLine(it.judge));
  if (it.differences) lines.push(differencesLine(it.differences));
  return lines.join("\n");
}

export async function devOnce(
  store: DevStore,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  await ensureIgnored(dirname(dirname(store.root)));
  const t = await prepareTarget(args, deps);
  const src = await featureSource(
    { config: t.config, target: t.target, root: store.root },
    args.flags,
    deps,
  );
  checkJudge(args, src, t.target);
  const claim = await claimSession(store, { pid: process.pid, url: null, target: t.target });
  if (!claim.held) return attachTo(claim.owner, args, io, deps);
  try {
    const warn = warnTo(io);
    const it = await onceRun(t, args, deps, { store, warn });
    if (args.judge) await judgeOnce(it, { args, src, warn }, deps);
    io.stdout.write(`${args.json ? jsonOf(it, null) : textOf(it)}\n`);
    return 0;
  } finally {
    await claim.release();
  }
}

/** Debounced saves (filtered through git's ignores unless `--watch` named the paths) start a run. */
async function watching(root: string, args: DevArgs, ctl: DevController): Promise<() => void> {
  const explicit = args.watch.length > 0;
  const bounce = debounce(DEFAULT_QUIET_MS, async (paths) => {
    if (!explicit && paths.length > 0 && (await notIgnored(root, paths)).length === 0) return;
    await ctl.run();
  });
  const stop = await watchTree({ root, paths: explicit ? args.watch : undefined }, bounce.touch);
  return () => {
    stop();
    bounce.close();
  };
}

/** The keys: r run, p pin, u unpin, m main/previous; resolves on q, or on SIGTERM as if q. */
function keyLoop(input: KeyInput, ctl: DevController, io: Io): Promise<void> {
  return new Promise((done) => {
    const say = sayTo(io);
    const quit = () => {
      process.off("SIGTERM", quit);
      undo();
      done();
    };
    process.on("SIGTERM", quit);
    const undo = onKeys(input, (key) => {
      if (key === "r") void ctl.run();
      else if (key === "p")
        void ctl.pin().then((id) => say(id ? `pinned #${Number(id)}` : "nothing to pin yet"));
      else if (key === "u")
        void ctl.unpin().then((id) => say(id ? `unpinned #${Number(id)}` : "no pin to remove"));
      else if (key === "m")
        void ctl
          .toggleMain()
          .then((m) =>
            say(
              m.note ??
                `comparing with ${m.against === "main" ? "main" : "the previous iteration"}`,
            ),
          );
      else if (key === "f")
        void ctl
          .refreshRefs()
          .then((f) => say(f ? `refs refetched (${f.refs.length})` : "this target has no refs"))
          .catch((e: unknown) => say(`refs failed: ${e instanceof Error ? e.message : String(e)}`));
      else if (key === "q") quit();
    });
  });
}

/** A session this process holds: its live page, the controller, and how to end it. */
export type LiveSession = {
  url: string;
  target: string;
  /** The URL the target is shot at. */
  pageUrl: string;
  ctl: DevController;
  hasFeature: boolean;
  stop: () => Promise<void>;
};

/**
 * Serve the page, take the worktree's lock and watch for saves. When another process holds the
 * lock, nothing is left open and its owner is returned instead. `pixelslash mcp` starts its
 * session through this too (ob 1742).
 */
export async function startSession(
  store: DevStore,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<{ held: true; live: LiveSession } | { held: false; owner: DevLock }> {
  const root = dirname(dirname(store.root));
  await ensureIgnored(root);
  const t = await prepareTarget(args, deps);
  const feature = await featureSource(
    { config: t.config, target: t.target, root: store.root },
    args.flags,
    deps,
  );
  checkJudge(args, feature, t.target);
  const warn = warnTo(io);
  const src = await mainSource(args, deps, warn);
  const session = await openTarget(t, deps, warn);
  let url = "";
  const ctl = devController({
    store,
    session,
    target: t.target,
    maxBytes: DEFAULT_MAX_BYTES,
    main: src.main,
    noMain: src.noMain,
    againstMain: args.flags.against === "main",
    judge: args.judge ? { dsDir: args.flags.ds, deps } : undefined,
    feature,
    refreshRefs: args.refreshRefs,
    onRun: (it) => io.stdout.write(`${lineOf(it, url)}\n`),
    onJudge: (_it, judge) => io.stdout.write(`${judgeLine(judge)}\n`),
    onExplain: (_it, d) => io.stdout.write(`${differencesLine(d)}\n`),
    onRefs: (refs) => {
      for (const line of refLines(refs)) warn(line);
    },
    onError: (e) =>
      warn(`pixelslash dev: run failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const page = serveDevPage(store, t.target, ctl);
  url = page.url;
  const claim = await claimSession(store, { pid: process.pid, url, target: t.target });
  if (!claim.held) {
    await Promise.all([page.stop(), session.close()]);
    return claim;
  }
  let unwatch = noop;
  // The page stops before the last run is waited for: a click on Run after the wait would shoot
  // through a browser that is closing.
  const stop = async () => {
    unwatch();
    await page.stop();
    await ctl.idle();
    await session.close();
    await claim.release();
  };
  try {
    unwatch = await watching(root, args, ctl);
  } catch (e) {
    await stop();
    throw e;
  }
  const live = { url, target: t.target, pageUrl: t.url, ctl, hasFeature: Boolean(feature), stop };
  return { held: true, live };
}

/** Say why main is off, resolve the refs (so a missing token is said before the run), then run. */
export async function firstRun(live: LiveSession, io: Io): Promise<void> {
  const note = live.ctl.mode().note;
  if (note) warnTo(io)(note);
  if (live.hasFeature) await live.ctl.feature();
  void live.ctl.run();
}

/** The live loop: a session in this terminal, shooting on every save until `q`. */
export async function devLoop(
  store: DevStore,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  const started = await startSession(store, args, io, deps);
  if (!started.held) return attachTo(started.owner, args, io, deps);
  const { live } = started;
  try {
    const where = args.watch.length > 0 ? args.watch.join(", ") : "the working tree";
    io.stdout.write(
      `pixelslash dev: ${live.target} at ${live.pageUrl}, watching ${where}\nlive page: ${live.url}\nkeys: r run · p pin · u unpin · m main/previous${live.hasFeature ? " · f refetch refs" : ""} · q quit\n`,
    );
    await firstRun(live, io);
    await keyLoop(deps.keys ?? process.stdin, live.ctl, io);
    return 0;
  } finally {
    await live.stop();
  }
}

/** The lock names a `--once` run, which has no page to attach to. */
export function onceInProgress(pid: number): never {
  throw new UsageError(
    `a \`pixelslash dev --once\` (pid ${pid}) is running in this worktree; try again when it ends`,
  );
}
