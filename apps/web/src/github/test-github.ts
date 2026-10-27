import { generateKeyPairSync } from "node:crypto";
import { type GithubAppConfig, type GithubAppDeps, type GithubFetch, createGithubApp } from "./app";

/** A stand-in for GitHub's REST API, for the App's tests: no network. Tests only. */

const TEST_APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});

const TEST_APP_CONFIG: GithubAppConfig = {
  appId: "123456",
  privateKey: TEST_APP_KEY,
  apiBase: "https://api.github.test",
};

/** One call GitHub got; `raw` is the JSON body as sent, empty for none. */
export type Call = { method: string; path: string; auth: string; raw: string };

/** What the stand-in does with the next calls: answer, fail with a status, or never answer. */
export type Mode = "ok" | { status: number } | "hang";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function never(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function callOf(url: string, init: RequestInit): Call {
  return {
    method: init.method ?? "GET",
    path: new URL(url).pathname,
    auth: new Headers(init.headers).get("authorization") ?? "",
    raw: typeof init.body === "string" ? init.body : "",
  };
}

export function fakeGithub({ now = Date.now }: { now?: () => number } = {}) {
  const calls: Call[] = [];
  let mode: Mode = "ok";
  let minted = 0;
  let nextRun = 100;

  /** GitHub's answer to a call that gets one. */
  function route(method: string, path: string): Response {
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path))
      return reply(200, { id: 77 });
    if (method === "POST" && path === "/app/installations/77/access_tokens") {
      minted += 1;
      const expiresAt = new Date(now() + 60 * 60_000).toISOString();
      return reply(201, { token: `ghs_token${minted}`, expires_at: expiresAt });
    }
    if (method === "POST" && path.endsWith("/check-runs")) return reply(201, { id: nextRun++ });
    if (method === "PATCH" && /\/check-runs\/\d+$/.test(path)) return reply(200, {});
    return reply(404, { message: "Not Found" });
  }

  const fetch: GithubFetch = async (url, init) => {
    const call = callOf(url, init);
    calls.push(call);
    if (mode === "hang") return never(init.signal);
    if (mode !== "ok") return reply(mode.status, { message: "GitHub is down" });
    return route(call.method, call.path);
  };

  return {
    fetch,
    calls,
    setMode: (next: Mode) => {
      mode = next;
    },
    /** The calls on check runs, without the token traffic. */
    checkRunCalls: () => calls.filter((c) => c.path.includes("/check-runs")),
    app: (deps: GithubAppDeps = {}) => createGithubApp(TEST_APP_CONFIG, { fetch, now, ...deps }),
  };
}
