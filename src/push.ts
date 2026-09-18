import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunManifest } from "./run.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PushError extends Error {}

export function defaultApiUrlPath(): string {
  return join(homedir(), ".omnibus_api_url");
}

export function defaultApiTokenPath(): string {
  return join(homedir(), ".ob_api_token");
}

export function resolveOrigin(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.OMNIBUS_API?.trim();
  if (fromEnv) return stripSlash(fromEnv);
  const path = env.OMNIBUS_API_URL_FILE?.trim() || defaultApiUrlPath();
  if (!existsSync(path)) throw new PushError(`need OMNIBUS_API or ${path} for --push`);
  const origin = readFileSync(path, "utf8").trim();
  if (!origin) throw new PushError(`API url file empty: ${path}`);
  return stripSlash(origin);
}

export function resolveToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.OMNIBUS_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const path = env.OB_API_TOKEN_FILE?.trim() || defaultApiTokenPath();
  if (!existsSync(path)) throw new PushError(`need OMNIBUS_API_TOKEN or ${path} for --push`);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new PushError(`token file empty: ${path}`);
  return token;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export async function pushRun(opts: {
  origin: string;
  token: string;
  main: Buffer;
  branch: Buffer;
  diff: Buffer;
  manifest: RunManifest;
  fetch: FetchLike;
}): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.set("main", new Blob([new Uint8Array(opts.main)], { type: "image/png" }), "main.png");
  form.set("branch", new Blob([new Uint8Array(opts.branch)], { type: "image/png" }), "branch.png");
  form.set("diff", new Blob([new Uint8Array(opts.diff)], { type: "image/png" }), "diff.png");
  form.set("manifest", JSON.stringify(opts.manifest));
  const res = await opts.fetch(`${opts.origin}/api/pixelslash/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
  if (res.status === 401) throw new PushError("push unauthorized");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PushError(`push failed ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { id?: unknown };
  const id = typeof json.id === "string" && json.id ? json.id : opts.manifest.id;
  return { id, url: `${opts.origin}/pixelslash/${id}` };
}
