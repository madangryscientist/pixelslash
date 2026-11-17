import { USER_AGENT } from "@hackcove/pixelslash-engine";

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
  /** One of the API's few writes (resolving a flake, a review decision), with a JSON body when it takes one. */
  post(path: string, body?: unknown): Promise<Reply>;
};

/** A signed blob URL (an image, a metrics file), fetched only when it is on the configured server. */
export async function fetchBlob(
  server: string,
  fetch: FetchLike,
  url: string,
): Promise<ArrayBuffer> {
  if (new URL(url).origin !== new URL(server).origin)
    throw new RemoteError(`${url} is not on ${server}; not fetched`);
  const res = await fetch(url).catch((e: unknown) => {
    throw new RemoteError(`cannot fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new RemoteError(`GET ${url} -> ${res.status}`);
  return res.arrayBuffer();
}

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

/**
 * What came back when the answer is not the API's own, such as a Cloudflare 520 page: the `cf-ray`
 * that names the request at the edge, and the start of the body. No retry: the cause has to show.
 */
function notApiAnswer(res: Response, text: string): string {
  const ray = res.headers.get("cf-ray");
  const head = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, 200));
  const body = head ? `body ${JSON.stringify(head)}` : "empty body";
  return `not the API's answer (${ray ? `cf-ray ${ray}` : "no cf-ray"}; ${body})`;
}

function refusal(server: string, call: string, res: Response, text: string): RemoteError {
  const detail = apiError(text) ?? notApiAnswer(res, text);
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
