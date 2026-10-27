import { PLATFORM, baselinePng, fetchBaselines } from "./baselines-client.ts";
import {
  type BaselinePick,
  type CiResult,
  type DiffLocation,
  ENGINE_VERSION,
  type PickedShot,
  measureShot,
} from "./ci-diff.ts";
import type { ChangeNoter } from "./change-note.ts";
import { DEFAULT_FLAKE_RETRIES } from "./config-flake.ts";
import { isHttpUrl } from "./routes.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import type { FlakeCheck } from "./flake.ts";
import { type FlakeOutcome, clearFlakeOutput, flakePass } from "./flake-upload.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import { identity, pngPath, readManifest } from "./manifest.ts";
import type { Shoot, SnapshotEntry } from "./snapshot.ts";
import { elapsed, requestLog, timingsToSend, type ShotTiming, type Timings } from "./timings.ts";
import { type Client, isObj, send } from "./upload-client.ts";

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
   * `upload --judge` (ob 1745): a sentence for each shot that changed, sent as its `changeNote`.
   * Each shot with a baseline is then measured here, whatever the project's diff location, to know
   * which changed; the sentence is read on the review pages and decides nothing.
   */
  describe?: ChangeNoter;
};

export type UploadResult = {
  buildId: string;
  snapshots: number;
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

/** What a shot sends beside its meta and PNG. */
type ShotExtras = { results: CiResult[]; flake: FlakeCheck | undefined; note: string | null };

/**
 * One shot's upload: its meta and PNG; in a CI project, what it measured against each baseline;
 * for a flaky shot, the flake record and every re-capture as `flake:<run>` (ob 1737); and the
 * judge's sentence, when it wrote one (ob 1745).
 */
function snapshotForm(
  e: SnapshotEntry,
  png: Buffer,
  { results, flake, note }: ShotExtras,
): FormData {
  const form = new FormData();
  const meta: Record<string, unknown> = snapshotMeta(e);
  if (note) meta.changeNote = note;
  if (results.length > 0) {
    meta.ci = {
      engineVersion: ENGINE_VERSION,
      results: results.map(({ baselineId, status, diffResult }) => ({
        baselineId,
        status,
        diffResult,
      })),
    };
    for (const r of results)
      form.set(`diff:${r.baselineId}`, new File([new Uint8Array(r.mask)], "diff.png"));
  }
  if (flake?.flaky) {
    meta.flake = flake.record;
    for (const r of flake.retries)
      form.set(`flake:${r.run}`, new File([new Uint8Array(r.png)], `run${r.run}.png`));
  }
  form.set("meta", JSON.stringify(meta));
  form.set("file", new File([new Uint8Array(png)], "shot.png"));
  return form;
}

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
    onRequest: (step, ms) => log.record(step, ms),
  };
  const { id, diffLocation } = await openBuild(client, ctx, opts.projectId, opts.brief);
  progress.opened = true;
  // A server from before ob 1727 has no baselines endpoint and diffs every build itself.
  const picked = diffLocation
    ? await fetchBaselines(client, { path: `/api/v1/builds/${id}/baselines` }, manifest.snapshots)
    : { diffLocation: "server", picks: [] };
  const ci = picked.diffLocation === "ci";
  const flakes = flakePass({
    dir: opts.dir,
    retries: opts.flakeRetries ?? DEFAULT_FLAKE_RETRIES,
    recapture: deps.recapture,
    warn,
  });
  await clearFlakeOutput(opts.dir);
  const timed: ShotTiming[] = [];
  const queue = manifest.snapshots.map((e, i) => ({ e, pick: picked.picks[i] }));
  const stop = { on: false };
  const worker = async () => {
    for (let next = queue.shift(); next && !stop.on; next = queue.shift()) {
      const { e, pick } = next;
      const file = pngPath(opts.dir, e);
      const png = Buffer.from(await Bun.file(file).arrayBuffer());
      // A server project measures at finalise; here its diff only decides whether to re-capture
      // and what the judge describes, and is never sent as the shot's result.
      const mains = new Map<string, Buffer>();
      const timing: ShotTiming = { name: identity(e) };
      const results =
        pick && (ci || flakes.retries > 0 || deps.describe)
          ? await measureTimed(client, { e, png, pick, mains }, timing)
          : [];
      if (results.length > 0) flakes.measured();
      const changed = results.find((r) => r.status === "changed");
      const flake = changed ? await flakes.check(e, png) : undefined;
      const note = await changeNote(deps.describe, { e, file, changed, mains }, warn, timing);
      timed.push(timing);
      await send(client, {
        step: `upload ${identity(e)}`,
        method: "PUT",
        path: `/api/v1/builds/${id}/snapshots`,
        body: snapshotForm(e, png, { results: ci ? results : [], flake, note }),
      });
      progress.sent++;
    }
  };
  await runWorkers(worker, stop);
  const sent = timingsToSend(opts.timings, started, log.finish(), timed);
  const done = await finalise(client, id, manifest.snapshots.length, sent);
  progress.finalised = true;
  checkOutcome(id, done);
  const outcome = await flakes.finish(manifest.snapshots);
  const timings = timingsToSend(opts.timings, started, log.finish(), timed);
  return {
    buildId: id,
    snapshots: manifest.snapshots.length,
    git: ctx,
    timings,
    ...outcome,
  };
}

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

/** The judge's sentence for a changed shot; a model that fails is said and the shot goes without. */
async function changeNote(
  describe: ChangeNoter | undefined,
  shot: {
    e: SnapshotEntry;
    file: string;
    changed: CiResult | undefined;
    mains: Map<string, Buffer>;
  },
  warn: (m: string) => void,
  timing: ShotTiming,
): Promise<string | null> {
  const { e, file, changed, mains } = shot;
  const main = changed && mains.get(changed.baselineId);
  if (!describe || !changed || !main) return null;
  const started = performance.now();
  try {
    return await describe({ file, main, diff: changed.diffResult });
  } catch (err) {
    warn(`judge: ${identity(e)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    timing.judgeMs = elapsed(started);
  }
}

/**
 * `measureShot` with its diff time on `timing`, less the baseline downloads inside it (those are
 * the `fetch baseline` requests). `mains` keeps the baselines for the judge.
 */
async function measureTimed(
  client: Client,
  shot: { e: SnapshotEntry; png: Buffer; pick: BaselinePick; mains: Map<string, Buffer> },
  timing: ShotTiming,
): Promise<CiResult[]> {
  const { e, png, pick, mains } = shot;
  let fetching = 0;
  const fetchMain = async (p: PickedShot) => {
    const started = performance.now();
    const bytes = await baselinePng(client, p);
    fetching += elapsed(started);
    mains.set(p.id, bytes);
    return bytes;
  };
  const started = performance.now();
  const results = await measureShot(e, png, pick, fetchMain);
  timing.diffMs = Math.max(0, elapsed(started) - fetching);
  return results;
}

function snapshotMeta(e: SnapshotEntry) {
  return {
    name: e.name,
    platform: PLATFORM,
    browser: e.variant.browser,
    viewport: `${e.variant.viewport.width}x${e.variant.viewport.height}`,
    theme: e.variant.theme,
    tags: e.tags,
    diff: e.diff,
    ignore: e.ignore,
    fingerprint: e.fingerprint,
    flaky: e.flaky,
    ...(e.composition && { composition: e.composition }),
  };
}
