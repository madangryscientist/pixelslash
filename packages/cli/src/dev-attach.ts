import { DEV_HEADER, type DevIteration, type DevLock } from "@pixelslash/engine";
import { type DevArgs, type DevDeps, jsonOf, lineOf } from "./dev.ts";
import { onKeys, onceInProgress } from "./dev-loop.ts";
import type { Io } from "./run.ts";

/**
 * A second `pixelslash dev` in a worktree that has one (ob 1740): it drives the live session
 * through its page rather than opening a second browser. Its own target and flags are not used.
 */

const POLL_MS = 400;

async function post(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: { [DEV_HEADER]: "1" } });
}

/** What the session's page says, read loosely: an iteration is anything with an id and timings. */
function iterationIn(body: unknown, key: string): DevIteration | null {
  const v: unknown = typeof body === "object" && body !== null ? Reflect.get(body, key) : null;
  return isIteration(v) ? v : null;
}

function isIteration(v: unknown): v is DevIteration {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof Reflect.get(v, "id") === "string" &&
    typeof Reflect.get(v, "timings") === "object"
  );
}

/** The session's latest iteration; undefined when the session is gone. */
async function state(url: string): Promise<{ latest: DevIteration | null } | undefined> {
  try {
    const res = await fetch(`${url}/api/state`);
    return res.ok ? { latest: iterationIn(await res.json(), "latest") } : undefined;
  } catch {
    return undefined;
  }
}

/** `--once` with a session up: the session runs it, and its iteration is printed. */
async function onceThrough(url: string, args: DevArgs, io: Io): Promise<number> {
  const res = await post(url, "/api/run");
  const iteration = iterationIn(await res.json(), "iteration");
  if (!iteration) {
    io.stderr.write("pixelslash dev: the session's run failed; its terminal says why\n");
    return 1;
  }
  io.stdout.write(`${args.json ? jsonOf(iteration, url) : lineOf(iteration, url)}\n`);
  return 0;
}

/** Print a line per new iteration of the session until `q`, or until the session goes away. */
function follow(url: string, io: Io, deps: DevDeps): Promise<void> {
  return new Promise((done) => {
    let seen: string | undefined;
    let first = true;
    const stop = () => {
      clearInterval(timer);
      undo();
      done();
    };
    const tick = async () => {
      const s = await state(url);
      if (!s) {
        io.stdout.write("pixelslash dev: the session ended\n");
        stop();
        return;
      }
      const it = s.latest;
      if (it && it.id !== seen && !first) io.stdout.write(`${lineOf(it, url)}\n`);
      seen = it?.id;
      first = false;
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    const routes: Record<string, string> = {
      r: "/api/run",
      p: "/api/pin",
      u: "/api/unpin",
      m: "/api/against",
    };
    const undo = onKeys(deps.keys ?? process.stdin, (key) => {
      const path = routes[key];
      if (path) void post(url, path).catch(() => {});
      else if (key === "q") stop();
    });
    void tick();
  });
}

export async function attachTo(
  owner: DevLock,
  args: DevArgs,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  if (owner.url === null) onceInProgress(owner.pid);
  const url = owner.url;
  if (args.target !== undefined && args.target !== owner.target)
    io.stderr.write(
      `pixelslash dev: this worktree's session is on ${owner.target}, not ${args.target}\n`,
    );
  if (args.once) return onceThrough(url, args, io);
  io.stdout.write(
    `pixelslash dev: attached to the session on ${owner.target} (pid ${owner.pid})\nlive page: ${url}\nkeys: r run · p pin · u unpin · m main/previous · q detach\n`,
  );
  const latest = (await state(url))?.latest;
  if (latest) io.stdout.write(`${lineOf(latest, url)}\n`);
  await follow(url, io, deps);
  return 0;
}
