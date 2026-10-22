import {
  type CaptureConfig,
  type CaptureSession,
  type FetchMain,
  UsageError,
  baselinesInto,
  devConfig,
  findConfigIfAny,
  loadDevConfig,
  narrowSession,
  openCaptureSession,
  probeTarget,
  targetName,
  targetUrl,
} from "@pixelslash/engine";
import { RemoteError } from "./api.ts";
import type { DevArgs, DevDeps } from "./dev.ts";
import { connect, resolveProject } from "./remote.ts";

/**
 * What a `pixelslash dev` session needs before its first run (ob 1740): the target's config with
 * no start command, a page that answers, the browser on it, and, when there are credentials, a
 * way to read main's baselines.
 */

export type DevTarget = { config: CaptureConfig; target: string; url: string };

/** The config narrowed to the target, and its URL answering; we never start the app. */
export async function prepareTarget(args: DevArgs, deps: DevDeps): Promise<DevTarget> {
  const cwd = deps.cwd ?? process.cwd();
  const opts = {
    name: args.target,
    url: args.flags.url,
    viewport: args.flags.viewport,
    theme: args.flags.theme,
  };
  const base = await loadDevConfig(findConfigIfAny(args.flags.config, cwd), args.flags.url);
  const config = devConfig(base, opts);
  const target = targetName(config, opts);
  const url = targetUrl(config, target) ?? config.baseUrl;
  // Always the real network: the URL is the user's own page, never the review server.
  await probeTarget(url);
  return { config, target, url };
}

/** The browser on the target; closed again when the target names no route or story. */
export async function openTarget(
  t: DevTarget,
  deps: DevDeps,
  warn: (m: string) => void,
): Promise<CaptureSession> {
  const session = await openCaptureSession(t.config, { ...deps, warn });
  try {
    return narrowSession(session, t.target);
  } catch (e) {
    await session.close();
    throw e;
  }
}

export type MainSource = { main: FetchMain | undefined; noMain: string };

/**
 * Main's baselines through the read-only form `check` uses, as whoever `pixelslash login` (or
 * `PIXELSLASH_TOKEN`) is. Resolving the credentials reads no network; the first fetch does.
 * Without credentials there is no fetcher and `noMain` says why.
 */
export async function mainSource(
  args: DevArgs,
  deps: DevDeps,
  warn: (m: string) => void,
): Promise<MainSource> {
  const cwd = deps.cwd ?? process.cwd();
  const flags = args.flags;
  let remote;
  try {
    remote = await connect(flags, { ...deps, cwd });
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof RemoteError)) throw e;
    return {
      main: undefined,
      noMain: `no credentials for main's baselines (${e.message}); comparing with the previous iteration`,
    };
  }
  const baseBranch = flags.base ?? remote.upload?.baseBranch ?? "main";
  const main: FetchMain = async (dirs, entries) => {
    const projectId = remote.token.startsWith("psu_")
      ? (await resolveProject(remote, flags.project)).id
      : undefined;
    const src = {
      server: remote.client.server,
      token: remote.token,
      projectId,
      git: { cwd, baseBranch },
    };
    await baselinesInto(src, dirs, entries, { ...deps, warn });
  };
  return { main, noMain: "" };
}
