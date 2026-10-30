import { UploadError, UsageError } from "@hackcove/pixelslash-engine";
import { RemoteError, isObj, str } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import { REMOTE_FLAGS, connect, listProjects, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";

/**
 * `pixelslash project create NAME` and `project list` (ob 1787): the one way a CI job makes a
 * project. An upload never does, so a mistyped name stays an error instead of a stray project.
 */

const REMOTE = "[--server URL] [--token-path PATH] [--config FILE]";
export const PROJECT_USAGE = `pixelslash project create NAME [--org NAME] ${REMOTE} [--json]\nMakes the project NAME in the token's org, or says it already exists; running it twice is fine. Exit 0 either way, 1 when the server refuses, 2 on a usage error. An org token (psorg_…) creates in its own org; a personal token in its only org, else --org says which.\npixelslash project list ${REMOTE} [--json]\nThe projects the token reaches.`;

/** `project create`: a refusal by the server is exit 1, as it is for `upload`. */
async function create(rest: string[], io: Io, deps: RemoteDeps): Promise<number> {
  const [name, ...more] = rest;
  if (!name || name.startsWith("--")) throw new UsageError("need a project NAME");
  const { json, rest: pairs } = takeJson(more);
  const flags = readFlagPairs(pairs, [...REMOTE_FLAGS, "org"]);
  const remote = await connect(flags, deps);
  let reply;
  try {
    reply = await remote.client.post("/api/v1/projects", {
      name,
      ...(flags.org !== undefined && { org: flags.org }),
    });
  } catch (e) {
    if (e instanceof RemoteError) throw new UploadError(e.message);
    throw e;
  }
  if (json) {
    io.stdout.write(`${reply.text}\n`);
    return 0;
  }
  const { body } = reply;
  const org = isObj(body.org) ? str(body.org.name) : "";
  io.stdout.write(
    `${body.created === true ? "created" : "already exists"}: ${str(body.name)} (${org}) ${str(body.id)}\n`,
  );
  return 0;
}

async function list(rest: string[], io: Io, deps: RemoteDeps): Promise<number> {
  const { json, rest: pairs } = takeJson(rest);
  const remote = await connect(readFlagPairs(pairs, REMOTE_FLAGS), deps);
  if (json) {
    io.stdout.write(`${(await remote.client.get("/api/v1/projects")).text}\n`);
    return 0;
  }
  const projects = await listProjects(remote.client);
  if (projects.length === 0) io.stdout.write("no projects\n");
  for (const p of projects) io.stdout.write(`${p.name} (${p.org}) ${p.id}\n`);
  return 0;
}

/** `pixelslash project create|list`. */
export async function runProject(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "create") return create(rest, io, deps);
  if (verb === "list") return list(rest, io, deps);
  throw new UsageError("need `project create NAME` or `project list`");
}
