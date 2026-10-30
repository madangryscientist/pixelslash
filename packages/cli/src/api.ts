import { USER_AGENT } from "@pixelslash/engine";

/**
 * The exit code for a remote command the server did not answer with what was asked: the token was
 * refused, the server could not be reached, the id is not there, or the server failed. Exit 1 stays
 * the new-violations code (invariant 3) and 2 the usage code.
 */
export const REMOTE_EXIT = 3;

/** Why a request to the server got no usable answer. The message never carries the token. */
export class RemoteError extends Error {}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A reply as sent (`text`, for `--json`) and parsed (`body`, for the table). */
export type Reply = { text: string; body: Record<string, unknown> };

/** The one way the CLI (and later the MCP server) talks to `/api/v1`: as one token, to one server. */
export type ApiClient = {
  server: string;
  get(path: string, query?: Record<string, string | undefined>): Promise<Reply>;
  /** A JSON body to one of the API's few writes (resolving a flake). */
  post(path: string, body: unknown): Promise<Reply>;
};

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isObj) : [];

/** The API's own error: `{error: {code, message}}` on a read endpoint, `{error: "…"}` on an upload one. */
function apiError(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed)) return undefined;
    const { error } = parsed;
    if (typeof error === "string") return error;
    if (isObj(error)) return [str(error.code), str(error.message)].filter(Boolean).join(": ");
  } catch {
    // Not JSON: not an answer the API gave.
  }
  return undefined;
}

function refusal(server: string, call: string, res: Response, text: string): RemoteError {
  const detail = apiError(text) ?? `not the API's answer (${res.statusText || "no JSON"})`;
  const hint = res.status === 401 ? `; run \`pixelslash login --server ${server}\`` : "";
  return new RemoteError(`${call} -> ${res.status} ${detail}${hint}`);
}

export function apiClient(server: string, token: string, fetch: FetchLike): ApiClient {
  const request = async (method: string, path: string, qs: string, body?: unknown) => {
    const call = `${method} ${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${server}${path}${qs}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new RemoteError(
        `cannot reach ${server}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw refusal(server, call, res, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RemoteError(`${call}: the server did not answer with JSON`);
    }
    if (!isObj(parsed)) throw new RemoteError(`${call}: the server's answer is not an object`);
    return { text, body: parsed };
  };
  return {
    server,
    get(path, query = {}) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
      return request("GET", path, params.size > 0 ? `?${params.toString()}` : "");
    },
    post: (path, body) => request("POST", path, "", body),
  };
}
