import { UploadError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { USER_AGENT } from "./version.ts";

/** The upload's one way to the API: a bounded retry and the server's answer in one line. */

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The wait before each retry: bounded, never a loop. The schedule adds up to 30 s, which outlasts
 * a LAN deploy (pixelslash-web is down for about 13 s, PS-224); a build left open by a shorter one
 * is orphaned.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
/** Tries per request: the first, then one after each wait. */
const TRIES = RETRY_DELAYS_MS.length + 1;

export type Client = {
  fetch: FetchLike;
  base: string;
  token: string;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The command speaking, for its errors and warnings: `check` fails as "check failed". Default `upload`. */
  verb?: "upload" | "check";
  /** Told how long each request took, retries included (ob 1791): the upload's timings. */
  onRequest?: (step: string, ms: number) => void;
};
/** `step` is what the CLI says failed: "open build", "upload <snapshot>", "finalize". */
export type Call = {
  step: string;
  method: string;
  path: string;
  body?: string | FormData;
  /** The reply is a PNG, not JSON: a baseline image. */
  png?: true;
};

/** One attempt's outcome: the reply, or why there is none and whether another try may get one. */
type Attempt = { ok: true; body: unknown } | { ok: false; message: string; transient: boolean };

/**
 * The server's answer in one line: the API's `{"error"}`, else the first line of the text (an
 * HTML error page from a proxy in front of the API is cut down to its text).
 */
function answer(text: string): { detail: string; fromApi: boolean } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObj(parsed) && typeof parsed.error === "string")
      return { detail: parsed.error, fromApi: true };
    // The endpoints after the read API (ob 1729) answer `{error: {code, message}}`.
    if (isObj(parsed) && isObj(parsed.error) && typeof parsed.error.message === "string")
      return { detail: parsed.error.message, fromApi: true };
  } catch {
    // Not JSON: not the API's own answer.
  }
  const plain = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(head|style|script)[^]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return { detail: (plain ?? "").slice(0, 200), fromApi: false };
}

async function attempt(client: Client, call: Call): Promise<Attempt> {
  const { body } = call;
  const headers: Record<string, string> = {
    authorization: `Bearer ${client.token}`,
    "user-agent": USER_AGENT,
  };
  if (typeof body === "string") headers["content-type"] = "application/json";
  let res: Response;
  try {
    const init = { method: call.method, headers, ...(body === undefined ? {} : { body }) };
    res = await client.fetch(`${client.base}${call.path}`, init);
  } catch (e) {
    const message = `${call.method} ${client.base}${call.path}: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, message, transient: true };
  }
  if (res.ok)
    return { ok: true, body: call.png ? Buffer.from(await res.arrayBuffer()) : await res.json() };
  const { detail, fromApi } = answer(await res.text().catch(() => ""));
  // The API answers every error it means with JSON. A 5xx without it, or a gateway status, came
  // from in front of the API (a proxy, a dev server) or from a Worker that died mid-request, so no
  // answer was given and another try may get one.
  const transient = [502, 503, 504].includes(res.status) || (res.status >= 500 && !fromApi);
  const message = `${call.method} ${call.path} -> ${res.status} ${detail}`.trim();
  return { ok: false, message, transient };
}

/**
 * One request to the API; anything but 2xx is an UploadError naming the step and carrying the
 * server's answer. A failure the API never answered is tried again, up to TRIES in all: every
 * step is safe to repeat (a snapshot sent again replaces itself, a finalise again with the same
 * count is a no-op), and a repeated open at worst leaves an empty, unfinalised build behind.
 */
export async function send(client: Client, call: Call): Promise<unknown> {
  const started = performance.now();
  try {
    return await sendWithRetries(client, call);
  } finally {
    client.onRequest?.(call.step, performance.now() - started);
  }
}

async function sendWithRetries(client: Client, call: Call): Promise<unknown> {
  const verb = client.verb ?? "upload";
  for (let n = 1; ; n++) {
    const result = await attempt(client, call);
    if (result.ok) return result.body;
    const tries = n === 1 ? "" : ` (after ${n} tries)`;
    if (!result.transient || n === TRIES)
      throw new UploadError(`${verb} failed: ${call.step}: ${result.message}${tries}`);
    client.warn(`${verb}: ${call.step}: ${result.message}; trying again (${n + 1}/${TRIES})`);
    await client.sleep(RETRY_DELAYS_MS[n - 1] ?? 0);
  }
}

/** A PNG the API serves: a baseline image (ob 1727). */
export async function sendPng(client: Client, call: Omit<Call, "png">): Promise<Buffer> {
  const body = await send(client, { ...call, png: true });
  if (!Buffer.isBuffer(body))
    throw new UploadError(`${client.verb ?? "upload"} failed: ${call.step}: no image`);
  return body;
}
