import { UploadError, UsageError } from "./errors.ts";
import { type GitOptions, gitContext } from "./git.ts";
import type { FetchLike } from "./figma.ts";
import { isHttpUrl } from "./routes.ts";
import { type Client, isObj, send } from "./upload-client.ts";

/** Where a skipped run is recorded: the server, the token and the build's project and subproject. */
export type SkippedOptions = {
  server: string;
  token: string;
  git: Omit<GitOptions, "env" | "warn">;
  projectId?: string | undefined;
  subproject?: string | undefined;
};

export type SkippedDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

function clientOf(opts: SkippedOptions, deps: SkippedDeps, warn: (m: string) => void): Client {
  return {
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    base: opts.server.replace(/\/+$/, ""),
    token: opts.token,
    warn,
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}

/**
 * Record on the server that this commit captured nothing on purpose (a task cache skipped the
 * capture): a build that is `passed` with no shots, so the commit's PixelSlash status still posts.
 * No shot is read or sent, and no baseline changes. A commit that already has a build keeps it.
 */
export async function uploadSkipped(
  opts: SkippedOptions,
  deps: SkippedDeps = {},
): Promise<{ buildId: string; recorded: boolean; git: { commitSha: string; branch: string } }> {
  if (!isHttpUrl(opts.server))
    throw new UsageError(`server must be an http(s) URL: ${opts.server}`);
  const warn = deps.warn ?? (() => {});
  const ctx = await gitContext({ ...opts.git, env: deps.env ?? process.env, warn });
  const body = await send(clientOf(opts, deps, warn), {
    step: "open build",
    method: "POST",
    path: "/api/v1/builds",
    body: JSON.stringify({
      ...ctx,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.subproject ? { subproject: opts.subproject } : {}),
      skipped: true,
    }),
  });
  if (!isObj(body) || typeof body.id !== "string")
    throw new UploadError("upload failed: server did not return a build id");
  // A commit the project already built keeps that build, and nothing is recorded (`skipped: false`).
  return { buildId: body.id, recorded: body.skipped !== false, git: ctx };
}
