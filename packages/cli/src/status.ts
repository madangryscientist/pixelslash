import { join, resolve } from "node:path";
import { UsageError } from "@hackcove/pixelslash-engine";
import { REMOTE_EXIT, RemoteError, isObj, objects, str } from "./api.ts";
import { REMOTE_FLAGS, connect, resolveProject, type Remote, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";
import { readFlagPairs, takeJson } from "./args.ts";

/** A reviewer rejected a shot: the build failed. Exit 1 stays the new-violations code. */
export const REJECTED_EXIT = 4;
/** The build still waits for processing or review (at `--timeout`, under `--wait`). */
export const WAITING_EXIT = 5;

export const STATUS_USAGE = `pixelslash status [--build ID | --commit SHA | --branch NAME] [--dir DIR] [--wait [--timeout 30m] [--interval 15s]] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
Default build: the one \`upload\` recorded in DIR (default pixelslash-snapshots), else the current commit's newest.
Exit 0 accepted or nothing changed, ${REJECTED_EXIT} rejected, ${WAITING_EXIT} still waiting, ${REMOTE_EXIT} the server did not answer or the build errored, 2 usage.`;

/** What `upload` leaves in the snapshot dir, so `status` finds the build it made. */
export const BUILD_FILE = "build.json";

export type StatusDeps = RemoteDeps & {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `30m`, `15s`, `1h`, `500ms`; a bare number is seconds. */
export function parseDuration(flag: string, raw: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw);
  const ms = m ? Number(m[1]) * (UNITS[m[2] ?? "s"] ?? 1000) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new UsageError(`--${flag} must be a duration like 30m, 15s or 1h (got "${raw}")`);
  return ms;
}

export type WaitOptions = { timeoutMs: number; intervalMs: number };

/** `--timeout` and `--interval`, defaults 30m and 15s; given without `--wait` they are a usage error. */
export function waitOptions(
  wait: boolean,
  flags: { timeout?: string | undefined; interval?: string | undefined },
): WaitOptions | undefined {
  if (!wait) {
    if (flags.timeout !== undefined || flags.interval !== undefined)
      throw new UsageError("--timeout and --interval need --wait");
    return undefined;
  }
  return {
    timeoutMs: parseDuration("timeout", flags.timeout ?? "30m"),
    intervalMs: parseDuration("interval", flags.interval ?? "15s"),
  };
}

type Recorded = { server: string; build: string; commit: string };

async function recorded(dir: string): Promise<Recorded | undefined> {
  const file = Bun.file(join(dir, BUILD_FILE));
  if (!(await file.exists())) return undefined;
  const body: unknown = await file.json().catch(() => undefined);
  if (!isObj(body) || !str(body.build) || !str(body.server)) return undefined;
  return { server: str(body.server), build: str(body.build), commit: str(body.commit) };
}

/** Record the build `upload` made, for `status`. */
export async function recordBuild(dir: string, record: Recorded): Promise<void> {
  await Bun.write(join(dir, BUILD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

async function headSha(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out)
    throw new UsageError(
      "no build recorded and no git commit here: pass --build, --commit or --branch",
    );
  return out;
}

type Pick = { commit?: string; branch?: string };

/**
 * The newest build of the project that matches: on `branch`, or at a commit `commit` starts.
 * One page of the newest 100: a commit older than that is named with `--build`.
 */
async function findBuild(remote: Remote, project: string | undefined, pick: Pick): Promise<string> {
  const p = await resolveProject(remote, project);
  const path = `/api/v1/projects/${encodeURIComponent(p.id)}/builds`;
  const { body } = await remote.client.get(path, { branch: pick.branch, limit: "100" });
  const hit = objects(body.builds).find(
    (b) => pick.commit === undefined || str(b.commit_sha).startsWith(pick.commit),
  );
  if (hit) return str(hit.id);
  const what = pick.commit ? `at commit ${pick.commit.slice(0, 12)}` : `on ${pick.branch}`;
  throw new RemoteError(`no build in ${p.name} ${what}`);
}

type StatusFlags = Partial<Record<"build" | "commit" | "branch" | "dir" | "project", string>>;

async function buildId(remote: Remote, flags: StatusFlags, cwd: string): Promise<string> {
  const picked = [flags.build, flags.commit, flags.branch].filter((f) => f !== undefined);
  if (picked.length > 1) throw new UsageError("pick one of --build, --commit and --branch");
  if (flags.build) return flags.build;
  if (flags.commit || flags.branch) return findBuild(remote, flags.project, flags);
  const own = await recorded(resolve(cwd, flags.dir ?? "pixelslash-snapshots"));
  const head = await headSha(cwd);
  // A build recorded for another server, or at another commit, is not the one just made here.
  if (own && own.server === remote.client.server && own.commit === head) return own.build;
  return findBuild(remote, flags.project, { commit: head });
}

type Outcome = "processing" | "waiting" | "accepted" | "rejected" | "errored";

/** Where the build stands. A flaky shot under `skip` is not in `to_review`, so it never waits. */
export function outcomeOf(b: Record<string, unknown>): Outcome {
  switch (str(b.status)) {
    case "passed":
      return "accepted";
    case "failed":
      return "rejected";
    case "errored":
      return "errored";
    case "changes":
      return "waiting";
    default:
      return "processing";
  }
}

const EXIT: Record<Outcome, number> = {
  accepted: 0,
  rejected: REJECTED_EXIT,
  errored: REMOTE_EXIT,
  waiting: WAITING_EXIT,
  processing: WAITING_EXIT,
};

const num = (counts: unknown, key: string): number =>
  isObj(counts) && typeof counts[key] === "number" ? counts[key] : 0;

/** One line saying where the build is, the same each poll until something moves. */
function summary(b: Record<string, unknown>): string {
  const c = b.counts;
  const error = b.error ? ` (${str(b.error)})` : "";
  return `${str(b.status)}${error}: ${num(c, "to_review")} waiting · ${num(c, "accepted")} accepted · ${num(c, "rejected")} rejected`;
}

function describe(b: Record<string, unknown>): string {
  const lines = [`build ${str(b.id)}  ${str(b.web_url)}`, summary(b)];
  for (const shot of objects(b.snapshots).filter((x) => x.skipped_flaky === true))
    lines.push(`skipped flaky: ${str(shot.name)} (${str(shot.viewport)} ${str(shot.theme)})`);
  return `${lines.join("\n")}\n`;
}

type Read = { text: string; build: Record<string, unknown> };

async function read(remote: Remote, id: string): Promise<Read> {
  const path = `/api/v1/builds/${encodeURIComponent(id)}`;
  const reply = await remote.client.get(path);
  const { build } = reply.body;
  if (!isObj(build)) throw new RemoteError(`GET ${path}: no build in the answer`);
  return { text: reply.text, build };
}

/** The build to follow, how, and whether to print the API's reply as sent. */
export type Watch = { remote: Remote; id: string; wait?: WaitOptions | undefined; json: boolean };

const settled = (o: Outcome) => o !== "processing" && o !== "waiting";

const clock = (deps: StatusDeps) => ({
  sleep: deps.sleep ?? ((ms: number) => Bun.sleep(ms)),
  now: deps.now ?? Date.now,
});

/** Read the build until it settles or `wait.timeoutMs` passes; without `wait`, once. */
async function poll(watch: Watch, io: Io, deps: StatusDeps): Promise<Read> {
  const { remote, id, wait } = watch;
  const { sleep, now } = clock(deps);
  const deadline = now() + (wait?.timeoutMs ?? 0);
  let last = "";
  for (;;) {
    const current = await read(remote, id);
    const left = deadline - now();
    if (!wait || settled(outcomeOf(current.build)) || left <= 0) return current;
    const line = summary(current.build);
    if (line !== last && !watch.json) io.stderr.write(`waiting on build ${id}: ${line}\n`);
    last = line;
    await sleep(Math.min(wait.intervalMs, left));
  }
}

/** Follow the build as `watch` says, print where it ended, and return its exit code. */
export async function follow(watch: Watch, io: Io, deps: StatusDeps): Promise<number> {
  const end = await poll(watch, io, deps);
  const outcome = outcomeOf(end.build);
  io.stdout.write(watch.json ? `${end.text}\n` : describe(end.build));
  if (watch.wait && !settled(outcome))
    io.stderr.write(`still ${outcome} after ${watch.wait.timeoutMs / 1000}s\n`);
  return EXIT[outcome];
}

const FLAGS = [
  ...REMOTE_FLAGS,
  "project",
  "build",
  "commit",
  "branch",
  "dir",
  "timeout",
  "interval",
] as const;

/** `pixelslash status`: a build's review state; with `--wait`, block until it is decided. */
export async function runStatus(argv: string[], io: Io, deps: StatusDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const wait = rest.includes("--wait");
  const flags = readFlagPairs(
    rest.filter((a) => a !== "--wait"),
    FLAGS,
  );
  const options = waitOptions(wait, flags);
  const remote = await connect(flags, deps);
  const id = await buildId(remote, flags, deps.cwd ?? process.cwd());
  return follow({ remote, id, wait: options, json }, io, deps);
}
