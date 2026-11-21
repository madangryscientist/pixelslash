import { resolve } from "node:path";
import {
  UsageError,
  findConfigIfAny,
  isHttpUrl,
  loadConfig,
  resolveToken,
  type CaptureConfig,
} from "@slashsuite/pixelslash-engine";
import { apiClient, objects, str, type ApiClient, type FetchLike } from "./api.ts";
import { storedToken } from "./credentials.ts";

/** The flags every remote command takes: which server, as whom, and where the config is. */
export const REMOTE_FLAGS = ["server", "token-path", "config"] as const;

export type RemoteFlags = Partial<Record<(typeof REMOTE_FLAGS)[number] | "project", string>>;

export type RemoteDeps = { fetch?: FetchLike; env?: NodeJS.ProcessEnv; cwd?: string };

type UploadConfig = CaptureConfig["upload"];

/**
 * A client for the resolved server and token, `via` saying where the token came from. `token` is
 * for `upload`, whose client is the engine's; never print it.
 */
export type Remote = {
  client: ApiClient;
  token: string;
  via: string;
  upload: UploadConfig | undefined;
};

/** A project the token reaches; `parentId` is set for a subproject, null for a top-level project. */
export type Project = { id: string; name: string; org: string; parentId: string | null };

/** The config's `upload` block, when there is a config (`--config`, or one in the working dir). */
export async function uploadConfig(
  flags: RemoteFlags,
  cwd: string,
): Promise<UploadConfig | undefined> {
  const path = findConfigIfAny(flags.config, cwd);
  return path ? (await loadConfig(path)).upload : undefined;
}

/** `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config. */
export function resolveServer(
  flags: RemoteFlags,
  env: NodeJS.ProcessEnv,
  upload: UploadConfig | undefined,
): string {
  const server = flags.server ?? env.PIXELSLASH_SERVER ?? upload?.server;
  if (!server)
    throw new UsageError("need --server URL, PIXELSLASH_SERVER, or upload.server in the config");
  if (!isHttpUrl(server)) throw new UsageError(`server must be an http(s) URL: ${server}`);
  return server.replace(/\/+$/, "");
}

/** `--token-path`, else `PIXELSLASH_TOKEN` (CI), else what `pixelslash login` stored for `server`. */
async function token(
  flags: RemoteFlags,
  env: NodeJS.ProcessEnv,
  server: string,
): Promise<{ token: string; via: string }> {
  const path = flags["token-path"];
  if (path)
    return {
      token: await resolveToken(resolve(path), env, "PIXELSLASH_TOKEN"),
      via: "--token-path",
    };
  const fromEnv = env.PIXELSLASH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, via: "PIXELSLASH_TOKEN" };
  const stored = await storedToken(env, server);
  if (stored) return { token: stored, via: "stored credential" };
  throw new UsageError(
    `not logged in to ${server}: run \`pixelslash login --server ${server}\`, or set PIXELSLASH_TOKEN or --token-path`,
  );
}

export async function connect(flags: RemoteFlags, deps: RemoteDeps = {}): Promise<Remote> {
  const env = deps.env ?? process.env;
  const upload = await uploadConfig(flags, deps.cwd ?? process.cwd());
  const server = resolveServer(flags, env, upload);
  const auth = await token(flags, env, server);
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  return { client: apiClient(server, auth.token, fetch), ...auth, upload };
}

export async function listProjects(client: ApiClient): Promise<Project[]> {
  const { body } = await client.get("/api/v1/projects");
  return objects(body.projects).map((p) => {
    const org = objects([p.org])[0];
    const parent = p.parent_project_id;
    return {
      id: str(p.id),
      name: str(p.name),
      org: str(org?.name),
      parentId: typeof parent === "string" ? parent : null,
    };
  });
}

const listed = (projects: Project[]) =>
  projects.map((p) => `  ${p.name} (${p.org}) ${p.id}`).join("\n");

/** A subproject named by `--project`: refused, with how an upload names it. */
function notASubproject(project: Project, projects: Project[]): Project {
  if (project.parentId === null) return project;
  const parent = projects.find((p) => p.id === project.parentId);
  throw new UsageError(
    `"${project.name}" is a subproject: --project names a top-level project; upload names this one with --project ${parent?.name ?? project.parentId} --subproject ${project.name}`,
  );
}

function onlyProject(projects: Project[], server: string): Project {
  const [only, ...more] = projects;
  if (only && more.length === 0) return only;
  if (!only) throw new UsageError(`the token sees no projects on ${server}`);
  throw new UsageError(
    `the token sees ${projects.length} projects: pass --project, or set upload.project in the config\n${listed(projects)}`,
  );
}

function namedProject(projects: Project[], wanted: string, orgToken = false): Project {
  const byId = projects.find((p) => p.id === wanted);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === wanted);
  const [hit, ...others] = byName;
  if (hit && others.length === 0) return hit;
  const missing = orgToken
    ? `is not a project in this org: create it with \`pixelslash project create ${wanted}\``
    : `is not a project this token sees`;
  const why = hit ? `is more than one project: pass its id` : missing;
  throw new UsageError(`"${wanted}" ${why}\n${listed(hit ? byName : projects)}`);
}

/** A project's own `psci_` token holds one project; a personal or org token names which. */
export const namesProject = (secret: string) => secret.startsWith("psu_") || isOrgToken(secret);

const isOrgToken = (secret: string) => secret.startsWith("psorg_");

/**
 * `--project` (an id or a name), else `upload.project` in the config, else the only project a
 * personal token sees. More than one and none named is a usage error listing them. An org token
 * always names its project: which one a monorepo's job builds is never "the only one" (ob 1787).
 */
export async function resolveProject(remote: Remote, flag: string | undefined): Promise<Project> {
  const wanted = flag ?? remote.upload?.project;
  if (wanted === undefined && isOrgToken(remote.token))
    throw new UsageError(
      "an org token reaches every project of its org: pass --project NAME, or set upload.project in the config",
    );
  const all = await listProjects(remote.client);
  // `--project` names a top-level project; a subproject is named only by `--subproject`.
  const projects = all.filter((p) => p.parentId === null);
  if (wanted === undefined) return onlyProject(projects, remote.client.server);
  const subproject = all.find((p) => p.parentId !== null && p.id === wanted);
  if (subproject) return notASubproject(subproject, all);
  try {
    return namedProject(projects, wanted, isOrgToken(remote.token));
  } catch (e) {
    const named = all.find((p) => p.parentId !== null && p.name === wanted);
    if (named) return notASubproject(named, all);
    throw e;
  }
}
