import { appendFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEV_DIR, type DevStore } from "./dev-store.ts";
import type { FetchLike } from "./figma.ts";

/**
 * One `pixelslash dev` session per worktree (ob 1740): `session.json` in the store names the live
 * one's pid and page. A second `dev` reads it and attaches; a lock whose process is gone is stale
 * and is taken over.
 */

export type DevLock = {
  pid: number;
  /** The live page; null for a `--once` run, which has none. */
  url: string | null;
  target: string;
};

export type Claim = { held: true; release: () => Promise<void> } | { held: false; owner: DevLock };

export type LockDeps = { fetch?: FetchLike; pidAlive?: (pid: number) => boolean };

const lockFile = (store: DevStore) => join(store.root, "session.json");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return e instanceof Error && Reflect.get(e, "code") === "EPERM";
  }
}

function isLock(v: unknown): v is DevLock {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof Reflect.get(v, "pid") === "number" &&
    typeof Reflect.get(v, "target") === "string"
  );
}

export async function readLock(store: DevStore): Promise<DevLock | undefined> {
  const file = Bun.file(lockFile(store));
  if (!(await file.exists())) return undefined;
  try {
    const value: unknown = await file.json();
    return isLock(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The lock's process is running and, when it has a page, the page answers. */
async function lockLive(lock: DevLock, deps: LockDeps): Promise<boolean> {
  if (!(deps.pidAlive ?? pidAlive)(lock.pid)) return false;
  if (lock.url === null) return true;
  try {
    const res = await (deps.fetch ?? fetch)(`${lock.url}/api/state`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The live session of this worktree, if there is one. */
export async function liveSession(
  store: DevStore,
  deps: LockDeps = {},
): Promise<DevLock | undefined> {
  const lock = await readLock(store);
  return lock && (await lockLive(lock, deps)) ? lock : undefined;
}

async function create(store: DevStore, lock: DevLock): Promise<boolean> {
  await mkdir(store.root, { recursive: true });
  try {
    const fh = await open(lockFile(store), "wx");
    await fh.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
    await fh.close();
    return true;
  } catch (e) {
    if (e instanceof Error && Reflect.get(e, "code") === "EEXIST") return false;
    throw e;
  }
}

/** Take the worktree's session, or name who holds it. A stale lock is removed and taken. */
export async function claimSession(
  store: DevStore,
  lock: DevLock,
  deps: LockDeps = {},
): Promise<Claim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await create(store, lock)) {
      const release = async () => {
        if ((await readLock(store))?.pid === lock.pid) await rm(lockFile(store), { force: true });
      };
      return { held: true, release };
    }
    const owner = await readLock(store);
    if (owner && (await lockLive(owner, deps))) return { held: false, owner };
    await rm(lockFile(store), { force: true });
  }
  const owner = await readLock(store);
  return owner ? { held: false, owner } : { held: false, owner: lock };
}

/** The worktree's top directory, or `cwd` outside git. */
export async function worktreeRoot(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : cwd;
}

/** Add `.pixelslash/dev/` to the worktree's `.gitignore` unless git already ignores it. */
export async function ensureIgnored(root: string): Promise<boolean> {
  const probe = Bun.spawn(["git", "check-ignore", "-q", join(DEV_DIR, "session.json")], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await probe.exited;
  // 0: ignored; 128: not a git checkout, so there is nothing to keep it out of.
  if (code !== 1) return false;
  const file = Bun.file(join(root, ".gitignore"));
  const text = (await file.exists()) ? await file.text() : "";
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  await appendFile(join(root, ".gitignore"), `${sep}.pixelslash/dev/\n`);
  return true;
}
