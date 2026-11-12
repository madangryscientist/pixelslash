import { join } from "node:path";
import { fetchBaselines } from "./baselines-client.ts";
import type { BaselinePick, DiffLocation } from "./ci-diff.ts";
import type { ChangeNoter } from "./change-note.ts";
import { DEFAULT_FLAKE_RETRIES } from "./config-flake.ts";
import { isHttpUrl } from "./routes.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { type FlakeOutcome, clearFlakeOutput, flakePass } from "./flake-upload.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import { identity, readManifest } from "./manifest.ts";
import type { Shoot, SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
import {
  loadNow,
  requestLog,
  timingsToSend,
  type UploadRun,
  type ShotTiming,
  type Timings,
} from "./timings.ts";
import { type Client, isObj, send } from "./upload-client.ts";
import { readShot } from "./upload-form.ts";
import { shotSender } from "./upload-send.ts";
import { changeNote, measurePng, sameAsBaselines } from "./upload-measure.ts";
import { knownImages } from "./upload-known.ts";

const CONCURRENCY = 4;
export type UploadOptions = {
  dir: string;
  server: string;
  token: string;
  git: Omit<GitOptions, "env" | "warn">;
  /** The project to open the build in: required with a personal token, which reaches several. */
  projectId?: string | undefined;
  /**
   * How many more times a shot that differs from its baseline is captured (ob 1737); 0 turns it
   * off. Default 2. It needs `recapture`: without one nothing is captured again.
   */
  flakeRetries?: number | undefined;
  /** The CLI's own timings so far, such as its capture; sent with the build at finalize (ob 1791). */
  timings?: Timings | undefined;
  /** The author's brief (PS-232), sent with the build when given; never written to the manifest. */
  brief?: string | undefined;
};

/** How far an upload got, filled in as it goes (PS-223), so a failure can say what reached the server. */
export type UploadProgress = {
  /** A build was opened on the server. */
  opened: boolean;
  /** The id the server gave the build, set when it answers "open build" (PS-343). */
  buildId?: string;
  /** Shots the server has answered for. */
  sent: number;
  total: number;
  /** The finalise was answered: the build is complete. */
  finalised: boolean;
};

export const newUploadProgress = (): UploadProgress => ({
  opened: false,
  sent: 0,
  total: 0,
  finalised: false,
});

export type UploadDeps = {
  /** Filled in by `uploadSnapshots` as it goes. */
  progress?: UploadProgress;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Where the git checkout and the config are looked for. Default: the process's. */
  cwd?: string;
  warn?: (message: string) => void;
  /** How a retry waits. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Capture a manifest entry again, the same way it was captured; `undefined` when the config no
   * longer has its route or variant. Without it, a changed shot is uploaded as captured.
   */
  recapture?: (e: SnapshotEntry) => Promise<Shoot | undefined>;
  /**
   * How many re-captures may run at once (PS-447): the capture concurrency of the session that
   * `recapture` shoots on. Default 1.
   */
  recaptureConcurrency?: number | undefined;
  /**
   * The shots (`identity`) captured on a pooled preview page (PS-445). Each is measured whatever
   * the retries, and kept only where it equals its baseline: one that differs, or has none, is shot
   * again through `recapture` on a fresh page, and that PNG replaces it on disk and in the upload.
   * Ignored without `recapture`.
   */
  reused?: ReadonlySet<string> | undefined;
  /**
   * `upload --judge` (ob 1745): a sentence for each shot that changed, sent as its `changeNote`.
   * Each shot with a baseline is then measured here, whatever the project's diff location, to know
   * which changed; the sentence is read on the review pages and decides nothing.
   */
  describe?: ChangeNoter;
};

export type UploadResult = {
  buildId: string;
  snapshots: number;
  /** How many shots from a pooled preview page were shot again on a fresh page (PS-445). */
  reshot: number;
  git: GitContext;
  /**
   * The run's timings (ob 1791): the CLI's own plus this upload's, finalize included. The server
   * was sent the same figures up to the finalize, which cannot include its own duration.
   */
  timings: Timings;
} & FlakeOutcome;

/**
 * Finalise, and again while the server's diff runs out of budget with shots left (ob 1645). The
 * server resumes: a finalise sent again measures only what is not yet measured, so this is the
 * CLI doing what a person would otherwise click. It goes on only while the count left falls, so a
 * build that is failing for another reason is tried once more and then given up, never looped.
 */
async function finalise(
  client: Client,
  id: string,
  count: number,
  timings: Timings | undefined,
): Promise<unknown> {
  let left = Infinity;
  for (;;) {
    const reply = await send(client, {
      step: "finalize",
      method: "POST",
      path: `/api/v1/builds/${id}/finalize`,
      body: JSON.stringify({ snapshots: count, ...(timings ? { timings } : {}) }),
    });
    if (!isObj(reply) || reply.status !== "errored") return reply;
    const now = reply.unmeasured;
    if (typeof now !== "number" || now <= 0 || now >= left) return reply;
    client.warn(`upload: ${now} of ${count} shots still to measure on the server; continuing`);
    left = now;
  }
}

/**
 * A finalise runs the diff in the request, so its reply is the outcome. `processing` means a retry
 * met an earlier try's run that has not ended (or was killed): nothing was measured yet. `errored`
 * is a failed upload (PS-228): `finalise` has already given up on it, so the server could not
 * measure the build and a CI step that read exit 0 would pass a build nobody diffed. The reason is
 * the server's; the build page, when the server names it, goes on the same line so the last line
 * of stderr stays the `UPLOAD FAILED:` one.
 */
function checkOutcome(id: string, done: unknown): void {
  if (!isObj(done)) return;
  if (done.status === "processing")
    throw new UploadError(`upload failed: finalize: build ${id} is still processing on the server`);
  if (done.status === "errored") {
    const page = typeof done.web_url === "string" && done.web_url ? ` (${done.web_url})` : "";
    throw new UploadError(
      `upload failed: build ${id} errored on the server: ${String(done.error)}${page}`,
    );
  }
}

type OpenBuild = {
  id: string;
  /** Where the project diffs; absent from a server from before ob 1727, which always diffs itself. */
  diffLocation: DiffLocation | undefined;
};

/** `clientDiff` says this CLI can measure: a project that diffs in CI refuses one that cannot. */
async function openBuild(
  client: Client,
  ctx: GitContext,
  projectId: string | undefined,
  brief: string | undefined,
): Promise<OpenBuild> {
  const body = await send(client, {
    step: "open build",
    method: "POST",
    path: "/api/v1/builds",
    body: JSON.stringify({
      ...ctx,
      ...(projectId ? { projectId } : {}),
      ...(brief ? { brief } : {}),
      clientDiff: true,
    }),
  });
  if (!isObj(body) || typeof body.id !== "string")
    throw new UploadError("upload failed: server did not return a build id");
  const at = body.diffLocation;
  return { id: body.id, diffLocation: at === "ci" || at === "server" ? at : undefined };
}

/** What the upload adds to the timings it sends: its shots' steps, its worker count and the load it began at. */
const uploadRun = (shots: ShotTiming[], count: number, loadStart: number): UploadRun => ({
  shots,
  workers: { upload: Math.max(1, Math.min(CONCURRENCY, count)) },
  loadStart,
});

/**
 * Send a snapshot dir to a PixelSlash server: open a build, upload each PNG, finalise.
 * The only network this package does for a page shot, and only to `server`. If anything
 * fails the build is left open on the server (unfinalised, uncounted) and this throws.
 */
export async function uploadSnapshots(
  opts: UploadOptions,
  deps: UploadDeps = {},
): Promise<UploadResult> {
  const env = deps.env ?? process.env;
  if (!isHttpUrl(opts.server))
    throw new UsageError(`server must be an http(s) URL: ${opts.server}`);
  const base = opts.server.replace(/\/+$/, "");
  const fetcher = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const started = performance.now();
  const loadStart = loadNow();
  const manifest = await readManifest(opts.dir);
  const progress = deps.progress ?? newUploadProgress();
  progress.total = manifest.snapshots.length;
  const warn = deps.warn ?? (() => {});
  const ctx = await gitContext({ ...opts.git, env, warn });
  const log = requestLog();
  const client: Client = {
    fetch: fetcher,
    base,
    token: opts.token,
    warn,
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
    onRequest: (step, ms, server) => log.record(step, ms, server),
  };
  const { id, diffLocation } = await openBuild(client, ctx, opts.projectId, opts.brief);
  progress.opened = true;
  progress.buildId = id;
  // A server from before ob 1727 has no baselines endpoint and diffs every build itself.
  const picked = diffLocation
    ? await fetchBaselines(client, { path: `/api/v1/builds/${id}/baselines` }, manifest.snapshots)
    : { diffLocation: "server", picks: [] };
  const ci = picked.diffLocation === "ci";
  const flakes = flakePass({
    dir: opts.dir,
    retries: opts.flakeRetries ?? DEFAULT_FLAKE_RETRIES,
    recapture: deps.recapture,
    concurrency: deps.recaptureConcurrency,
    warn,
  });
  await clearFlakeOutput(opts.dir);
  const known = await knownImages(client, id, opts.dir, manifest.snapshots);
  const timed: ShotTiming[] = [];
  const pooled = pooledOf(deps);
  const queue = manifest.snapshots.map((e, i) => ({ e, pick: picked.picks[i], pooled: pooled(e) }));
  const stop = { on: false };
  const measuring = needsMeasure(ci, flakes.retries, deps.describe);
  const sender = shotSender(client, id, { dir: opts.dir, known, sent: () => progress.sent++ });
  const run = { flakes, describe: deps.describe, warn };
  const worker = async () => {
    for (let next = queue.shift(); next && !stop.on; next = queue.shift()) {
      const shot = await measureOne(client, { ...next, dir: opts.dir, ci, measuring }, run);
      timed.push(shot.timing);
      await sender.send(shot);
    }
  };
  await runWorkers(worker, stop);
  await sender.flush();
  await saveReshot(opts.dir, manifest, flakes.reshot());
  const runTimings = uploadRun(timed, manifest.snapshots.length, loadStart);
  const sent = timingsToSend(opts.timings, started, log.finish(), runTimings);
  const done = await finalise(client, id, manifest.snapshots.length, sent);
  progress.finalised = true;
  checkOutcome(id, done);
  const outcome = await flakes.finish(manifest.snapshots);
  const timings = timingsToSend(opts.timings, started, log.finish(), runTimings);
  return {
    buildId: id,
    snapshots: manifest.snapshots.length,
    reshot: flakes.reshot(),
    git: ctx,
    timings,
    ...outcome,
  };
}

/**
 * Read one shot, measure it as far as this upload needs, and gather what its PUT or batch item
 * carries. A server project measures at finalise; here its diff only decides whether to re-capture
 * and what the judge describes, and is never sent as the shot's result. A shot from a pooled preview
 * page (PS-445) is kept only when it is byte for byte its baseline; otherwise, or with no baseline,
 * it is shot again on a fresh page, and that PNG is the shot from then on: on disk, in the upload,
 * in the measure and as the first run the flake check compares with.
 */
async function measureOne(
  client: Client,
  shot: {
    e: SnapshotEntry;
    pick: BaselinePick | undefined;
    dir: string;
    ci: boolean;
    measuring: boolean;
    pooled: boolean;
  },
  run: {
    flakes: ReturnType<typeof flakePass>;
    describe: ChangeNoter | undefined;
    warn: (m: string) => void;
  },
) {
  const { e, pick, ci, pooled } = shot;
  const { flakes } = run;
  const read = await readShot(shot.dir, e);
  const { file, metrics } = read;
  const mains = new Map<string, Buffer>();
  const timing: ShotTiming = { name: identity(e) };
  const { measuring } = shot;
  let png: Buffer = read.png;
  if (pooled && !(await sameAsBaselines(client, pick, png, mains))) {
    const fresh = await flakes.fresh(e);
    png = fresh.png;
    e.ignore = fresh.ignore;
    await Bun.write(file, png);
  }
  const m = await measurePng(client, { e, png, pick, ci, measuring, mains }, timing);
  if (m.counted) flakes.measured();
  const { changed, results, hash } = m;
  const flake = changed ? await flakes.check(e, png) : undefined;
  const note = await changeNote(run.describe, { e, file, changed, mains }, run.warn, timing);
  return { e, png, hash, timing, extras: { results: ci ? results : [], flake, note, metrics } };
}

/** A shot shot again on a fresh page has that page's ignore boxes: the manifest says so too (PS-445). */
async function saveReshot(dir: string, manifest: SnapshotManifest, reshot: number): Promise<void> {
  if (reshot > 0)
    await Bun.write(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Whether a shot was taken on a pooled preview page; none is without `recapture` to shoot it fresh (PS-445). */
const pooledOf = (deps: UploadDeps) => (e: SnapshotEntry) =>
  deps.recapture !== undefined && deps.reused?.has(identity(e)) === true;

/** Whether a shot is measured here: a CI diff sends it, a re-capture or the judge reads it. */
const needsMeasure = (ci: boolean, retries: number, describe: ChangeNoter | undefined) =>
  ci || retries > 0 || describe !== undefined;

/**
 * Run `CONCURRENCY` workers to the end. One failure stops the rest pulling more and is thrown once
 * they have all settled, so the progress a crash reports (PS-223) is final, not still moving.
 */
async function runWorkers(worker: () => Promise<void>, stop: { on: boolean }): Promise<void> {
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, () =>
      worker().catch((e) => {
        stop.on = true;
        throw e;
      }),
    ),
  );
  for (const r of settled) if (r.status === "rejected") throw r.reason;
}
