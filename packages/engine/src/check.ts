import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type BaselinePick, type PickedShot, isBaselinePick, measureShot } from "./ci-diff.ts";
import { type CheckShot, type RemovedKey, addRemoved, shotsOf } from "./check-rows.ts";
import { renderCompareIndex } from "./compare-report.ts";
import { type SnapshotCompareResult, compareSnapshots } from "./compare-snapshots.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import type { Fingerprint } from "./fingerprint.ts";
import { type FlakyShot, flakePass } from "./flake-upload.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import { identity, pngPath } from "./manifest.ts";
import { isHttpUrl } from "./routes.ts";
import { type CaptureSession, type SnapshotEntry, captureInto, recapture } from "./snapshot.ts";
import { type Client, isObj, send, sendPng } from "./upload-client.ts";

/**
 * `pixelslash check` (ob 1732): capture here, measure against the baselines the server would pick
 * for this commit, and write the same report `compare` does. The server is only read: it is asked
 * for its pick (`POST /api/v1/baselines`, which creates nothing) and for the baseline images. No
 * shot, diff or flake leaves the machine, whatever the project's diff location.
 */

export type CheckOptions = {
  /** Holds `branch/` (this capture), `main/` (the baselines) and `report/` (`index.html`). */
  out: string;
  server: string;
  token: string;
  /** Required with a personal token, which reaches several projects. */
  projectId?: string | undefined;
  git: Pick<GitOptions, "cwd" | "baseBranch">;
  /** Route names to capture; the rest of the config is left out, and out of `removed`. */
  only?: string[] | undefined;
  /** How many more times a changed shot is captured; 0 turns it off. */
  flakeRetries: number;
};

export type CheckDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type { CheckShot } from "./check-rows.ts";

export type CheckResult = SnapshotCompareResult & {
  git: GitContext;
  flaky: FlakyShot[];
  /** The flake report in `branch/`, when a changed shot was captured again. */
  flakeReport: string | undefined;
  dirs: { branch: string; main: string; report: string };
  /** Every shot once, in report order, with its files as absolute paths: `--json`'s list. */
  shots: CheckShot[];
};

/** Keys per baselines request, as `upload` sends them: the server takes up to 2000. */
const KEYS_PER_REQUEST = 500;

function keyOf(e: SnapshotEntry) {
  const { width, height } = e.variant.viewport;
  const { browser, theme } = e.variant;
  return { name: e.name, platform: "linux", browser, viewport: `${width}x${height}`, theme };
}

const keyId = (k: RemovedKey) => [k.name, k.browser, k.viewport, k.theme].join(" / ");

function isRemovedKey(v: unknown): v is RemovedKey {
  return (
    isObj(v) &&
    ["name", "browser", "viewport", "theme"].every((k) => typeof Reflect.get(v, k) === "string")
  );
}

function readReply(reply: unknown): { picks: BaselinePick[]; removed: RemovedKey[] } {
  const sent: unknown[] = isObj(reply) && Array.isArray(reply.baselines) ? reply.baselines : [];
  if (sent.length === 0 || !sent.every(isBaselinePick))
    throw new UploadError("check failed: fetch baselines: the server's reply has no baselines");
  // A server from before ob 1732 does not say what would be removed: nothing is claimed.
  const named: unknown[] = isObj(reply) && Array.isArray(reply.removed) ? reply.removed : [];
  return { picks: sent, removed: named.filter(isRemovedKey) };
}

/**
 * The server's pick for every shot and what it would remove. A key the baseline build has is
 * removed only when no request asked about it, so across requests that is what all of them name.
 */
async function preview(
  client: Client,
  ctx: GitContext,
  projectId: string | undefined,
  entries: SnapshotEntry[],
): Promise<{ picks: BaselinePick[]; removed: RemovedKey[] }> {
  const picks: BaselinePick[] = [];
  let removed: RemovedKey[] | undefined;
  for (let i = 0; i < entries.length; i += KEYS_PER_REQUEST) {
    const reply = await send(client, {
      step: "fetch baselines",
      method: "POST",
      path: "/api/v1/baselines",
      body: JSON.stringify({
        ...ctx,
        ...(projectId ? { projectId } : {}),
        keys: entries.slice(i, i + KEYS_PER_REQUEST).map(keyOf),
      }),
    });
    const one = readReply(reply);
    picks.push(...one.picks);
    const ids = new Set(one.removed.map(keyId));
    removed = removed ? removed.filter((k) => ids.has(keyId(k))) : one.removed;
  }
  return { picks, removed: removed ?? [] };
}

function fingerprintOf(v: unknown, at: string): Fingerprint {
  const fp = isObj(v) ? v : {};
  const { image, browser, fonts } = fp;
  if (typeof image !== "string" || typeof browser !== "string" || typeof fonts !== "string")
    throw new UploadError(`check failed: ${at}: the server's baseline has no fingerprint`);
  return { image, browser, fonts };
}

/**
 * The baseline a shot is measured against, as finalise settles it (`diffOne` in the web app): a
 * carried change is kept when the shot is identical to it under the same environment, and any
 * other shot is measured against the accepted one. The pick itself is the server's.
 */
async function settle(
  e: SnapshotEntry,
  png: Buffer,
  pick: BaselinePick,
  fetchPng: (p: PickedShot) => Promise<Buffer>,
): Promise<PickedShot | null> {
  const { baseline } = pick;
  if (!baseline || !pick.carry) return baseline;
  const same = fingerprintOf(baseline.fingerprint, identity(e));
  const env = ["image", "browser", "fonts"] as const;
  if (env.every((k) => same[k] === e.fingerprint[k])) {
    const [measured] = await measureShot(e, png, { ...pick, accepted: null }, fetchPng);
    if (measured?.status === "unchanged") return baseline;
  }
  return pick.accepted;
}

/** `main/`: each shot's settled baseline under the shot's own file name, and its manifest. */
async function writeBaselines(
  client: Client,
  dirs: { branch: string; main: string },
  entries: SnapshotEntry[],
  picks: BaselinePick[],
): Promise<void> {
  const images = new Map<string, Promise<Buffer>>();
  const fetchPng = (p: PickedShot) => {
    const url = new URL(p.image_url, client.base);
    const got =
      images.get(p.id) ??
      sendPng(client, {
        step: `fetch baseline ${p.id}`,
        method: "GET",
        path: `${url.pathname}${url.search}`,
      });
    images.set(p.id, got);
    return got;
  };
  const snapshots: SnapshotEntry[] = [];
  for (const [i, e] of entries.entries()) {
    const pick = picks[i];
    if (!pick) continue;
    const png = Buffer.from(await Bun.file(pngPath(dirs.branch, e)).arrayBuffer());
    const chosen = await settle(e, png, pick, fetchPng);
    if (!chosen) continue;
    const dest = join(dirs.main, e.file);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, await fetchPng(chosen));
    snapshots.push({
      ...e,
      ignore: chosen.ignore,
      fingerprint: fingerprintOf(chosen.fingerprint, identity(e)),
    });
  }
  const manifest = { version: 1, snapshots };
  await Bun.write(join(dirs.main, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function onlyRoutes(session: CaptureSession, only: string[] | undefined): CaptureSession {
  if (!only) return session;
  const known = new Set(session.routes.map((r) => r.name));
  const unknown = only.filter((n) => !known.has(n));
  if (unknown.length > 0)
    throw new UsageError(
      `--only: no route ${unknown.join(", ")} in the config (it has ${[...known].join(", ")})`,
    );
  return { ...session, routes: session.routes.filter((r) => only.includes(r.name)) };
}

/** The git context, refused as a usage error: `check` reads the checkout and sends nothing. */
async function gitOf(opts: CheckOptions, deps: CheckDeps): Promise<GitContext> {
  const warn = deps.warn ?? (() => {});
  try {
    return await gitContext({
      ...opts.git,
      branch: undefined,
      pr: undefined,
      env: deps.env ?? process.env,
      warn,
    });
  } catch (e) {
    if (e instanceof UploadError) throw new UsageError(e.message.replace(/^upload/, "check"));
    throw e;
  }
}

/** 1737's pass over the changed rows: each captured again, and marked when it disagreed. */
async function flakeRows(
  result: SnapshotCompareResult,
  entries: SnapshotEntry[],
  session: CaptureSession,
  opts: { dir: string; retries: number; warn: (m: string) => void },
) {
  const flakes = flakePass({ ...opts, recapture: (e) => recapture(session, e) });
  for (let i = result.changed.length + result.unchanged.length; i > 0; i--) flakes.measured();
  const byKey = new Map(entries.map((e) => [identity(e), e]));
  for (const row of result.changed) {
    const e = byKey.get(row.key);
    if (!e) continue;
    const png = Buffer.from(await Bun.file(pngPath(opts.dir, e)).arrayBuffer());
    const flake = await flakes.check(e, png);
    if (flake?.flaky)
      row.flaky = { runs: flake.record.runs, differed: flake.record.differed.length };
  }
  return flakes.finish(entries);
}

function clientOf(opts: CheckOptions, deps: CheckDeps): Client {
  return {
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    base: opts.server.replace(/\/+$/, ""),
    token: opts.token,
    warn: deps.warn ?? (() => {}),
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}

/**
 * Capture through `session` into `out/branch`, fetch the server's baselines into `out/main`, and
 * compare the two into `out/report`. A changed shot is captured again `flakeRetries` times. Network
 * failures are UploadErrors; nothing is written to the server.
 */
export async function checkAgainstServer(
  session: CaptureSession,
  opts: CheckOptions,
  deps: CheckDeps = {},
): Promise<CheckResult> {
  if (!isHttpUrl(opts.server))
    throw new UsageError(`server must be an http(s) URL: ${opts.server}`);
  const shooting = onlyRoutes(session, opts.only);
  const ctx = await gitOf(opts, deps);
  const out = resolve(opts.out);
  const dirs = {
    branch: join(out, "branch"),
    main: join(out, "main"),
    report: join(out, "report"),
  };
  await rm(dirs.main, { recursive: true, force: true });
  await rm(dirs.report, { recursive: true, force: true });
  const { manifest } = await captureInto(shooting, dirs.branch);
  const client = clientOf(opts, deps);
  const { picks, removed } = await preview(client, ctx, opts.projectId, manifest.snapshots);
  await writeBaselines(client, dirs, manifest.snapshots, picks);
  const result = await compareSnapshots(
    { mainDir: dirs.main, branchDir: dirs.branch, out: dirs.report },
    { warn: client.warn },
  );
  addRemoved(result, removed, manifest.snapshots, opts.only);
  const outcome = await flakeRows(result, manifest.snapshots, shooting, {
    dir: dirs.branch,
    retries: opts.flakeRetries,
    warn: client.warn,
  });
  await Bun.write(
    result.indexPath,
    renderCompareIndex({
      ...result,
      title: "PixelSlash check",
      note: `Measured locally against ${client.base}'s baselines for ${ctx.branch} at ${ctx.commitSha.slice(0, 7)}: a preview, not a stored result. Nothing was uploaded.`,
      flakes: outcome.report ? relative(dirs.report, outcome.report) : undefined,
    }),
  );
  const shots = shotsOf(result, manifest.snapshots, dirs);
  return { ...result, git: ctx, flaky: outcome.flaky, flakeReport: outcome.report, dirs, shots };
}
