import { type FSWatcher, watch } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";

/**
 * `pixelslash dev`'s trigger (ob 1740): file events, debounced so a burst of saves is one run. By
 * default the git working tree minus ignored files is watched; `--watch PATHS` replaces it.
 */

export const DEFAULT_QUIET_MS = 150;

export type Debouncer = {
  /** A file changed; the run starts once nothing has for `quietMs`. */
  touch: (path: string) => void;
  close: () => void;
};

/**
 * Collect paths and call `run` with them once nothing has changed for `quietMs`. A change during a
 * run is not lost and does not start a second run alongside it: one more run follows it.
 */
export function debounce(quietMs: number, run: (paths: string[]) => Promise<void>): Debouncer {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let closed = false;
  const fire = async () => {
    timer = undefined;
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const paths = [...pending];
    pending = new Set();
    try {
      await run(paths);
    } finally {
      running = false;
      if (again && !closed) {
        again = false;
        void fire();
      }
    }
  };
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), ms);
  };
  return {
    touch: (path) => {
      pending.add(path);
      arm(quietMs);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

type Git = (args: string[], cwd: string, stdin?: string) => Promise<string>;

const runGit: Git = async (args, cwd, stdin) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
};

/** Our own output and git's: never a reason to run. */
function ownPath(rel: string): boolean {
  const first = rel.split(sep)[0];
  return first === ".git" || first === ".pixelslash";
}

/** The paths git does not ignore, of those given (relative to `root`). */
export async function notIgnored(
  root: string,
  paths: string[],
  git: Git = runGit,
): Promise<string[]> {
  const rels = paths.map((p) => relative(root, resolve(root, p))).filter((r) => !ownPath(r));
  if (rels.length === 0) return [];
  const ignored = new Set(
    (await git(["check-ignore", "--stdin"], root, rels.join("\n"))).split("\n"),
  );
  return rels.filter((r) => !ignored.has(r));
}

/** Every directory holding a tracked or untracked, not-ignored file: what the default watch covers. */
async function treeDirs(root: string, git: Git): Promise<string[]> {
  const files = (await git(["ls-files", "-co", "--exclude-standard"], root)).split("\n");
  const dirs = new Set([root]);
  for (const f of files) if (f) dirs.add(join(root, dirname(f)));
  return [...dirs];
}

export type WatchOptions = {
  root: string;
  /** `--watch`: watched recursively, nothing filtered but our own output. */
  paths?: string[] | undefined;
};

/** Watch and call `onChange(path)` per event that matters; returns the closer. */
export async function watchTree(
  opts: WatchOptions,
  onChange: (path: string) => void,
  git: Git = runGit,
): Promise<() => void> {
  const explicit = opts.paths && opts.paths.length > 0;
  const dirs = explicit
    ? (opts.paths ?? []).map((p) => resolve(opts.root, p))
    : await treeDirs(opts.root, git);
  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    try {
      const w = watch(dir, { recursive: Boolean(explicit) }, (_event, file) => {
        if (!file) return;
        const path = join(dir, file);
        if (!ownPath(relative(opts.root, path))) onChange(path);
      });
      watchers.push(w);
    } catch (e) {
      // A directory removed since git listed it has nothing to watch; a `--watch` path must exist.
      if (!explicit) continue;
      for (const w of watchers) w.close();
      throw new UsageError(`--watch ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return () => {
    for (const w of watchers) w.close();
  };
}
