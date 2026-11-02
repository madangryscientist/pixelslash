import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "@hackcove/pixelslash-engine";
import { isObj, str } from "./api.ts";

/**
 * `pixelslash login`'s store: one personal token per server, in a file only its owner can read.
 * `{ "servers": { "<server>": { "token": "psu_…" } } }`.
 */
type Store = { servers: Record<string, { token: string }> };

/** `$XDG_CONFIG_HOME/pixelslash/credentials.json`, else `~/.config/pixelslash/credentials.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(config, "pixelslash", "credentials.json");
}

async function load(path: string): Promise<Store> {
  if (!existsSync(path)) return { servers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UsageError(`${path} is not JSON: fix it or delete it and log in again`);
  }
  const servers: Store["servers"] = {};
  if (isObj(raw) && isObj(raw.servers))
    for (const [server, entry] of Object.entries(raw.servers)) {
      const token = isObj(entry) ? str(entry.token) : "";
      if (token) servers[server] = { token };
    }
  return { servers };
}

/** Written to a temp file at 0600 and renamed over, so the file is never readable by others or half-written. */
async function save(path: string, store: Store): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function storedToken(
  env: NodeJS.ProcessEnv,
  server: string,
): Promise<string | undefined> {
  return (await load(credentialsPath(env))).servers[server]?.token;
}

export async function storeToken(
  env: NodeJS.ProcessEnv,
  server: string,
  token: string,
): Promise<void> {
  const path = credentialsPath(env);
  const store = await load(path);
  store.servers[server] = { token };
  await save(path, store);
}

/** False when there was nothing stored for `server`. */
export async function forgetToken(env: NodeJS.ProcessEnv, server: string): Promise<boolean> {
  const path = credentialsPath(env);
  const store = await load(path);
  if (!store.servers[server]) return false;
  delete store.servers[server];
  await save(path, store);
  return true;
}
