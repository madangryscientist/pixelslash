import { UsageError } from "@pixelslash/engine";
import { apiClient, isObj, str, type Reply } from "./api.ts";
import { forgetToken, storeToken } from "./credentials.ts";
import {
  REMOTE_FLAGS,
  connect,
  listProjects,
  resolveServer,
  uploadConfig,
  type RemoteDeps,
} from "./remote.ts";
import type { Io } from "./run.ts";
import { readFlagPairs, takeJson } from "./args.ts";

export const LOGIN_USAGE =
  "pixelslash login [--server URL] [--config FILE]\nPaste a personal token (psu_…) when asked, or pipe it on stdin. It is stored for that server in ~/.config/pixelslash/credentials.json.";
export const LOGOUT_USAGE = "pixelslash logout [--server URL] [--config FILE]";
export const WHOAMI_USAGE =
  "pixelslash whoami [--server URL] [--token-path PATH] [--config FILE] [--json]";

/** Reads the token without echoing it: a prompt on a terminal, else the first line of stdin. */
export type ReadSecret = (prompt: string) => Promise<string>;

export type AccountDeps = RemoteDeps & { readSecret?: ReadSecret };

/** The first line of stdin. */
export async function firstLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("\n")) break;
    }
  } finally {
    reader.releaseLock();
  }
  return text.split("\n")[0] ?? "";
}

async function stty(arg: string): Promise<void> {
  await Bun.spawn(["stty", arg], { stdin: "inherit", stdout: "ignore", stderr: "ignore" }).exited;
}

const readStdinSecret: ReadSecret = async (prompt) => {
  if (!process.stdin.isTTY) return firstLine();
  process.stderr.write(prompt);
  await stty("-echo");
  try {
    return await firstLine();
  } finally {
    await stty("echo");
    process.stderr.write("\n");
  }
};

/** The `/me` reply's user, or undefined for a CI token. */
function meUser(me: Reply): { login: string; name: string } | undefined {
  const { user } = me.body;
  if (me.body.kind !== "user" || !isObj(user)) return undefined;
  return { login: str(user.login), name: str(user.name) };
}

/** `pixelslash login`: check a personal token against the server, then store it for that server. */
export async function runLogin(argv: string[], io: Io, deps: AccountDeps = {}): Promise<number> {
  const flags = readFlagPairs(argv, ["server", "config"]);
  const env = deps.env ?? process.env;
  const server = resolveServer(flags, env, await uploadConfig(flags, deps.cwd ?? process.cwd()));
  const read = deps.readSecret ?? readStdinSecret;
  io.stderr.write(`Create a personal token at ${server}/settings (API tokens).\n`);
  const token = (await read("Token: ")).trim();
  if (!token) throw new UsageError("no token given");
  if (!token.startsWith("psu_"))
    throw new UsageError(
      "login takes a personal token (psu_…); a CI token goes in PIXELSLASH_TOKEN or --token-path",
    );
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const user = meUser(await apiClient(server, token, fetch).get("/api/v1/me"));
  if (!user) throw new UsageError("the server did not take this as a personal token");
  await storeToken(env, server, token);
  io.stdout.write(`logged in to ${server} as ${user.login}\n`);
  return 0;
}

/** `pixelslash logout`: forget the stored token for the server. Nothing stored is not an error. */
export async function runLogout(argv: string[], io: Io, deps: AccountDeps = {}): Promise<number> {
  const flags = readFlagPairs(argv, ["server", "config"]);
  const env = deps.env ?? process.env;
  const server = resolveServer(flags, env, await uploadConfig(flags, deps.cwd ?? process.cwd()));
  const forgot = await forgetToken(env, server);
  io.stdout.write(forgot ? `logged out of ${server}\n` : `not logged in to ${server}\n`);
  return 0;
}

/** `pixelslash whoami`: the server, the token's source, its user and their orgs (or its CI project). */
export async function runWhoami(argv: string[], io: Io, deps: AccountDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const remote = await connect(readFlagPairs(rest, REMOTE_FLAGS), deps);
  const me = await remote.client.get("/api/v1/me");
  const projects = await listProjects(remote.client);
  const orgs = [...new Set(projects.map((p) => p.org))];
  const { server } = remote.client;
  if (json) {
    io.stdout.write(`${JSON.stringify({ server, via: remote.via, me: me.body, orgs })}\n`);
    return 0;
  }
  const user = meUser(me);
  const who = user
    ? `user: ${user.login}${user.name ? ` (${user.name})` : ""}\norgs: ${orgs.join(", ") || "none"}`
    : `CI token for project ${projects.map((p) => `${p.name} (${p.org})`).join(", ") || str(me.body.projectId)}`;
  io.stdout.write(`server: ${server}\ntoken: ${remote.via}\n${who}\n`);
  return 0;
}
