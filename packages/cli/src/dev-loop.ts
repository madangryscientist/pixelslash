import {
  DEFAULT_MAX_BYTES,
  DEFAULT_QUIET_MS,
  type DevController,
  type DevIteration,
  type DevJudge,
  type DevStore,
  UsageError,
  claimSession,
  debounce,
  devController,
  ensureIgnored,
  judgeIteration,
  notIgnored,
  runIteration,
  serveDevPage,
  watchTree,
} from "@pixelslash/engine";
import { dirname } from "node:path";
import { attachTo } from "./dev-attach.ts";
import { type DevArgs, type DevDeps, jsonOf, lineOf } from "./dev.ts";
import { type DevTarget, mainSource, openTarget, prepareTarget } from "./dev-setup.ts";
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
export async function devOnce(
  store: DevStore,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  await ensureIgnored(dirname(dirname(store.root)));
  const t = await prepareTarget(args, deps);
  const claim = await claimSession(store, { pid: process.pid, url: null, target: t.target });
  if (!claim.held) return attachTo(claim.owner, args, io, deps);
  try {
    const it = await onceRun(t, args, deps, { store, warn: warnTo(io) });
    if (args.judge && args.flags.ds) await judgeIteration(it, args.flags.ds, deps);
    io.stdout.write(`${args.json ? jsonOf(it, null) : lineOf(it, null)}\n`);
    if (!args.json && it.judge) io.stdout.write(`${judgeLine(it.judge)}\n`);
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

/** The keys: r run, p pin, u unpin, m main/previous; resolves on q. */
function keyLoop(input: KeyInput, ctl: DevController, io: Io): Promise<void> {
  return new Promise((done) => {
    const say = sayTo(io);
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
      else if (key === "q") {
        undo();
        done();
      }
    });
  });
}

/** The live loop: serve the page, take the worktree's lock, shoot on every save until `q`. */
export async function devLoop(
  store: DevStore,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  const root = dirname(dirname(store.root));
  await ensureIgnored(root);
  const t = await prepareTarget(args, deps);
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
    judge: args.judge && args.flags.ds ? { dsDir: args.flags.ds, deps } : undefined,
    onRun: (it) => io.stdout.write(`${lineOf(it, url)}\n`),
    onJudge: (_it, judge) => io.stdout.write(`${judgeLine(judge)}\n`),
    onError: (e) =>
      warn(`pixelslash dev: run failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const page = serveDevPage(store, t.target, ctl);
  url = page.url;
  const claim = await claimSession(store, { pid: process.pid, url, target: t.target });
  if (!claim.held) {
    await Promise.all([page.stop(), session.close()]);
    return attachTo(claim.owner, args, io, deps);
  }
  let unwatch = noop;
  try {
    unwatch = await watching(root, args, ctl);
    const where = args.watch.length > 0 ? args.watch.join(", ") : "the working tree";
    io.stdout.write(
      `pixelslash dev: ${t.target} at ${t.url}, watching ${where}\nlive page: ${url}\nkeys: r run · p pin · u unpin · m main/previous · q quit\n`,
    );
    if (ctl.mode().note) warn(ctl.mode().note ?? "");
    void ctl.run();
    await keyLoop(deps.keys ?? process.stdin, ctl, io);
    return 0;
  } finally {
    unwatch();
    await ctl.idle();
    await Promise.all([page.stop(), session.close()]);
    await claim.release();
  }
}

/** The lock names a `--once` run, which has no page to attach to. */
export function onceInProgress(pid: number): never {
  throw new UsageError(
    `a \`pixelslash dev --once\` (pid ${pid}) is running in this worktree; try again when it ends`,
  );
}
